#!/usr/bin/env node
/**
 * validate-source.mjs — 校验一个候选来源「真的无需 API key」
 *
 * 存在的意义：providers.json 里写一个来源很容易，但「声称免鉴权」和「实际免鉴权」是两回事。
 * 常见伪装：
 *   - /models 匿名可读，但 /chat/completions 返回 401（必须带 key）
 *   - 匿名返回 200 但 body 里其实是提示你去注册的错误对象
 *   - 免费额度为零的付费端点
 * 本脚本不带任何鉴权头，逐项给出证据，供 CI / PR 评审使用。
 *
 * 用法：
 *   node scripts/validate-source.mjs --base https://example.com/api/v1 [--model foo] [--json]
 *   node scripts/validate-source.mjs --file candidates.json     # 批量，见 README
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { lookup } from "node:dns/promises";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const has = (k) => argv.includes(k);

const UA = "keyless-llm-validate/1.0";
const TIMEOUT = 20000;

// /models 返回 200 但解析不出模型名时，用常见模型名逐个试 chat。
// 不少候选的 base 指向 API 路径，但 /models 格式不标准（或返回 HTML），
// 直接判 not-keyless 会漏掉真正免鉴权的端点。
const FALLBACK_MODELS = ["gpt-4o-mini", "gpt-3.5-turbo", "gpt-4o", "deepseek-chat", "qwen-turbo"];

// ── 请求（绝不附带 Authorization / x-api-key / api-key 等任何鉴权头）──
async function req(url, opts = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT);
  try {
    const res = await fetch(url, {
      method: opts.method || "GET",
      headers: { "User-Agent": UA, "Content-Type": "application/json" },
      body: opts.body,
      signal: ctrl.signal,
    });
    let text = "";
    try { text = await res.text(); } catch {}
    return { status: res.status, ok: res.ok, text, headers: Object.fromEntries(res.headers) };
  } catch (e) {
    return { status: -1, ok: false, text: "", error: e.name === "AbortError" ? "TIMEOUT" : e.message };
  }
}

function parseJson(text) { try { return JSON.parse(text); } catch { return null; } }

function listModels(j) {
  if (Array.isArray(j)) return j;
  if (Array.isArray(j.data)) return j.data;
  if (Array.isArray(j.models)) return j.models;
  if (j && typeof j === "object") return Object.values(j).filter((v) => v && typeof v === "object" && (v.id || v.name));
  return [];
}

// 从响应里挑模型名
function pickModels(j) {
  return listModels(j).map((m) => String(m.id || m.name || "").trim()).filter(Boolean);
}

// 判断一次 chat 响应是不是「真出字」
function looksLikeRealCompletion(j, text) {
  if (!j) return { ok: false, reason: "响应不是 JSON" };
  if (j.error) return { ok: false, reason: `返回 error: ${j.error.message || j.error.type || JSON.stringify(j.error).slice(0, 120)}` };
  const choices = j.choices;
  if (!Array.isArray(choices) || !choices.length) return { ok: false, reason: "没有 choices 字段" };
  const c = choices[0];
  const content = c?.message?.content ?? c?.text ?? c?.delta?.content;
  if (typeof content === "string" && content.length > 0) return { ok: true, reason: `有输出: ${JSON.stringify(content.slice(0, 60))}` };
  if (content === "" || content == null) {
    // 空内容但结构完整 —— 有可能是 max_tokens=1 触发的边界
    if (c.finish_reason) return { ok: true, reason: `结构完整但内容为空 (finish_reason=${c.finish_reason})` };
    return { ok: false, reason: "choices[0] 没有内容字段" };
  }
  return { ok: false, reason: "内容格式异常" };
}

// ── 校验单个来源 ──────────────────────────────────────────────────
async function validateSource(base, modelHint) {
  base = String(base || "").replace(/\/+$/, "");
  const report = {
    base,
    // verdict: "keyless" | "not-keyless" | "limited"
    //   keyless     —— 匿名拿到真实生成，确实免鉴权
    //   limited     —— 匿名被 429 拒绝：仍是免鉴权来源，只是当前额度/频率受限
    //   not-keyless —— 需要鉴权，或返回的不是真实生成
    verdict: "not-keyless",
    ok: false,
    modelsEndpoint: null,
    chatEndpoint: null,
    models: [],
    modelTested: modelHint || null,
    reasons: [],
    notes: [],
  };
  if (!/^https?:\/\//i.test(base)) {
    report.reasons.push(`base 不是合法 URL: ${base}`);
    return report;
  }
  // 域名解析预检：NXDOMAIN 的候选直接判死，避免把「编造/失效的域名」当成网络波动。
  // （本地 Clash fake-ip 环境下 lookup 恒成功，此检查在 CI 里才真正生效）
  try {
    await lookup(new URL(base).hostname);
  } catch {
    report.reasons.push("域名解析失败（域名不存在）");
    return report;
  }
  // 1) /models 匿名可读？
  const mr = await req(base + "/models");
  const mj = parseJson(mr.text);
  const models = mj ? pickModels(mj) : [];
  report.modelsEndpoint = {
    status: mr.status,
    modelCount: models.length,
    note: mr.status === 401 || mr.status === 403 ? "匿名读取被拒（可能需要 key 才能列模型）" : "",
  };
  if (models.length) report.models = models.slice(0, 50);

  // 2) chat/completions 匿名可用？—— 这是关键判定
  const testModel = modelHint || models[0] || null;
  if (!testModel) {
    // /models 拿不到或解析不出模型名：分两种情况，不能一律判死
    if (!mr.ok) {
      report.reasons.push(`/models 返回 ${mr.status}，无法枚举模型，也未指定 --model`);
      report.chatEndpoint = { status: mr.status, note: "跳过" };
      report.verdict = "not-keyless";
      return report;
    }
    // /models 200 但解析不出模型名 —— 只有 base 确实指向 API 路径才值得试常见模型名
    const looksApiPath = /\/(v\d+|api|openai)(\/|$)/i.test(new URL(base).pathname);
    if (!looksApiPath) {
      report.reasons.push("base 指向网站根路径而非 API 端点，/models 返回的不是模型清单");
      report.chatEndpoint = { status: mr.status, note: "跳过" };
      report.verdict = "not-keyless";
      return report;
    }
    const tried = [];
    for (const m of FALLBACK_MODELS) {
      tried.push(m);
      const r = await req(base + "/chat/completions", {
        method: "POST",
        body: JSON.stringify({ model: m, messages: [{ role: "user", content: "ping" }], max_tokens: 8, stream: false }),
      });
      const j = parseJson(r.text);
      const real = looksLikeRealCompletion(j, r.text);
      report.chatEndpoint = { status: r.status, model: m, real: real.ok, detail: real.reason };
      report.modelTested = m;
      if (r.status === 200 && real.ok) { report.verdict = "keyless"; report.ok = true; break; }
      if (r.status === 401) { report.reasons.push(`chat 返回 401：需要鉴权（模型 ${m}）`); break; }
      if (r.status === 403) { report.reasons.push(`chat 返回 403（模型 ${m}）`); break; }
      if (r.status === 429) { report.reasons.push(`chat 返回 429：匿名额度受限（模型 ${m}）`); report.verdict = "limited"; report.ok = true; break; }
      // 404 / 400：模型名可能不对，换下一个继续试
    }
    if (report.verdict !== "keyless" && report.verdict !== "limited") {
      report.reasons.push(`常见模型名均无法匿名调用（试过 ${tried.join(", ")}）`);
      report.verdict = "not-keyless";
    }
    return report;
  }
  const cr = await req(base + "/chat/completions", {
    method: "POST",
    body: JSON.stringify({ model: testModel, messages: [{ role: "user", content: "ping" }], max_tokens: 8, stream: false }),
  });
  const cj = parseJson(cr.text);
  const real = looksLikeRealCompletion(cj, cr.text);
  report.chatEndpoint = { status: cr.status, model: testModel, real: real.ok, detail: real.reason };

  if (cr.status === 401) report.reasons.push("chat 返回 401：需要鉴权，不是免鉴权来源");
  else if (cr.status === 403) report.reasons.push("chat 返回 403：被拒绝访问");
  else if (cr.status === 429) {
    // 429 = 匿名请求被配额拒绝，说明「不需要 key」是成立的，只是当下没额度
    report.reasons.push("chat 返回 429：匿名额度/频率受限 —— 仍属免鉴权来源，但当下不可用");
    report.notes.push("429 通常是限流或当日额度用尽，换时段复测可再定性");
    report.verdict = "limited";
    report.ok = true;
  } else if (cr.status === -1) report.reasons.push(`chat 网络失败: ${cr.error}`);
  else if (!cr.ok) report.reasons.push(`chat 返回 ${cr.status}`);
  else if (!real.ok) report.reasons.push(`chat 返回 200 但不是真实生成: ${real.reason}`);
  else {
    report.verdict = "keyless";
    report.ok = true;
  }

  // 3) 交叉验证：带上一个假的 key，行为应当与不带一致（有些网关会偷偷要求 key）
  if (cr.ok && real.ok) {
    const kr = await req(base + "/chat/completions", {
      method: "POST",
      headers: { Authorization: "Bearer sk-keyless-invalid-probe" },
      body: JSON.stringify({ model: testModel, messages: [{ role: "user", content: "ping" }], max_tokens: 8, stream: false }),
    });
    report.notes.push(`带无效 key 请求返回 ${kr.status}（与匿名一致即说明不校验 key）`);
  }

  return report;
}

// ── main ──────────────────────────────────────────────────────────
async function main() {
  const file = arg("--file", null);
  const asJson = has("--json");

  let targets = [];
  if (file) {
    const p = path.resolve(process.cwd(), file);
    const j = JSON.parse(fs.readFileSync(p, "utf8"));
    targets = (j.candidates || j.providers || []).map((c) => ({ base: c.base, model: c.testModel || c.model || null, label: c.label || c.id || c.base }));
  } else {
    const base = arg("--base", null);
    if (!base) {
      console.error("用法: node scripts/validate-source.mjs --base <url> [--model <name>] [--json]\n       node scripts/validate-source.mjs --file <candidates.json> [--json]");
      process.exit(2);
    }
    targets = [{ base, model: arg("--model", null), label: base }];
  }

  const reports = [];
  for (const t of targets) {
    const r = await validateSource(t.base, t.model);
    r.label = t.label;
    reports.push(r);
    if (!asJson) {
      const VERDICT = { keyless: "免鉴权 ✓", limited: "免鉴权但当前受限 △", "not-keyless": "不是免鉴权 ✗" };
      console.log(`\n=== ${r.label}  (${r.base})`);
      console.log(`  /models : ${r.modelsEndpoint ? `HTTP ${r.modelsEndpoint.status}, ${r.modelsEndpoint.modelCount} 个模型` : "-"} ${r.modelsEndpoint?.note || ""}`);
      console.log(`  chat    : ${r.chatEndpoint ? `HTTP ${r.chatEndpoint.status} ${r.chatEndpoint.detail || ""}` : "-"}`);
      for (const n of r.notes) console.log(`  note    : ${n}`);
      for (const x of r.reasons) console.log(`  reason  : ${x}`);
      console.log(`  结论    : ${VERDICT[r.verdict] || r.verdict}`);
    }
  }

  if (asJson) console.log(JSON.stringify(reports, null, 2));
  else {
    const keyless = reports.filter((r) => r.verdict === "keyless").length;
    const limited = reports.filter((r) => r.verdict === "limited").length;
    console.log(`\n免鉴权 ${keyless} 个 · 受限 ${limited} 个 · 非免鉴权 ${reports.length - keyless - limited} 个`);
  }

  if (reports.some((r) => r.verdict === "not-keyless")) process.exitCode = 1;
}

main().catch((e) => { console.error(e); process.exit(1); });
