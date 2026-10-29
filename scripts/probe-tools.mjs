#!/usr/bin/env node
/**
 * probe-tools.mjs — 实测各来源模型是否真的支持工具调用（agent 能力）
 *
 * 为什么需要单独一层：
 *   /models 里的 supported_parameters 只是「声明」，不等于「可用」。
 *   2026-10-29 实测踩到两类坑：
 *     - chat 的 gpt-4o-mini 声明进了清单，实际 HTTP 400「Tool calling is not supported」
 *     - kilo 的 nemotron-3-ultra 元数据写 tools=true，实际把工具调用以文本形式泄漏到
 *       content（`[[{ "name": ... }]]`），没有结构化 tool_calls，标准 agent 客户端用不了
 *   这类差异只能靠带 tools 的真实请求打出来。
 *
 * 探测方式：发一个带 get_weather 工具定义、tool_choice=required 的最小请求，
 *   看响应是否出现 choices[0].message.tool_calls（OpenAI 标准结构化工具调用）。
 *   这是 agent 框架（Claude Code / OpenCode / Cline 等）实际依赖的字段。
 *
 * 额度：每个模型 1 次请求。只测 providers.json 里 enabled 来源的 staticModels，
 *   且跳过已显式标注 tools:false 的模型；429/超时最多重试 RETRY 次。
 *
 * 用法：
 *   node scripts/probe-tools.mjs [--out snapshots/tools.json] [--quiet]
 * 环境变量：
 *   KEYLESS_TOOLS_TIMEOUT  单请求超时（毫秒），默认 45000
 *   KEYLESS_TOOLS_RETRY    429/超时重试次数，默认 1
 *   KEYLESS_PROBE_ENV      环境标注 ci|local，默认按 CI 变量推断
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const has = (k) => argv.includes(k);

const OUT = path.resolve(ROOT, arg("--out", "snapshots/tools.json"));
const QUIET = has("--quiet");
const TIMEOUT = parseInt(process.env.KEYLESS_TOOLS_TIMEOUT || "45000", 10);
const RETRY = parseInt(process.env.KEYLESS_TOOLS_RETRY || "1", 10);
const ENV_LABEL = process.env.KEYLESS_PROBE_ENV || (process.env.CI ? "ci" : "local");

const TOOL = {
  type: "function",
  function: {
    name: "get_weather",
    description: "Get the current weather for a city",
    parameters: {
      type: "object",
      properties: { city: { type: "string", description: "City name" } },
      required: ["city"],
    },
  },
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => { if (!QUIET) console.log(...a); };

// ── 待测清单：enabled 来源的 staticModels（跳过 tools:false 与已确认失效的）──
function loadTargets() {
  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, "providers.json"), "utf8"));
  const out = [];
  for (const p of cfg.providers || []) {
    if (p.enabled === false) continue;
    if (p.api && p.api !== "openai-completions") continue;   // 只测 OpenAI 兼容来源
    const base = String(p.base || "").replace(/\/+$/, "");
    for (const m of p.staticModels || []) {
      const id = typeof m === "string" ? m : m?.id;
      if (!id) continue;
      if (typeof m === "object" && m.tools === false) continue;  // 已确认不支持，跳过省额度
      out.push({ pid: p.id, label: p.label || p.id, model: id, base });
    }
  }
  return out;
}

async function callOnce(base, model) {
  const body = {
    model,
    messages: [{ role: "user", content: "What's the weather in Paris? Use the get_weather tool." }],
    tools: [TOOL],
    tool_choice: "required",
    max_tokens: 128,
    stream: false,
  };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT);
  try {
    const r = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": "keyless-llm-probe/1.0" },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    const text = await r.text();
    let j = null;
    try { j = JSON.parse(text); } catch {}
    return { status: r.status, j, text };
  } catch (e) {
    return { status: -1, j: null, text: "", error: e.name === "AbortError" ? "TIMEOUT" : e.message };
  } finally {
    clearTimeout(timer);
  }
}

function classify(res) {
  const { status, j, text, error } = res;
  if (status === -1) return { verdict: "inconclusive", detail: error || "network" };
  const msg = j?.choices?.[0]?.message;
  const finish = j?.choices?.[0]?.finish_reason;
  const toolCalls = msg?.tool_calls;
  if (Array.isArray(toolCalls) && toolCalls.length) {
    return { verdict: "tools_confirmed", detail: `tool_calls: ${toolCalls.map((c) => c.function?.name).filter(Boolean).join(",") || "?"}` };
  }
  if (finish === "tool_calls") return { verdict: "tools_confirmed", detail: "finish_reason=tool_calls" };
  if (status === 200) {
    const blob = `${msg?.content ?? ""}\n${msg?.reasoning_content ?? ""}`;
    if (/get_weather|tool_calls?|function/i.test(blob)) {
      return { verdict: "tools_text", detail: "200，工具调用以文本泄漏，无结构化 tool_calls" };
    }
    return { verdict: "text_only", detail: "200，未调用工具（可能模型选择直接回答）" };
  }
  if (status === 400 || status === 422) {
    const errMsg = j?.error?.message || text;
    // 只有错误信息明确指向工具/函数才判「不支持」；
    // 其余 400（如 Internal server error）是服务端临时故障，不能误判成能力缺失
    if (/tool|function|tool_choice/i.test(String(errMsg))) {
      return { verdict: "tools_rejected", detail: `HTTP ${status}: ${String(errMsg).slice(0, 200)}` };
    }
    return { verdict: "inconclusive", detail: `HTTP ${status}（非工具相关错误）: ${String(errMsg).slice(0, 160)}` };
  }
  if (status === 404) return { verdict: "model_missing", detail: `HTTP 404: ${(j?.error?.message || text).slice(0, 160)}` };
  if (status === 429) return { verdict: "inconclusive", detail: "429 限流" };
  if (status === 401 || status === 403) return { verdict: "inconclusive", detail: `HTTP ${status} 鉴权/封禁` };
  return { verdict: "inconclusive", detail: `HTTP ${status}: ${(j?.error?.message || text).slice(0, 120)}` };
}

async function probeOne(t) {
  let last = null;
  for (let attempt = 0; attempt <= RETRY; attempt++) {
    const res = await callOnce(t.base, t.model);
    last = { status: res.status, ...classify(res) };
    if (last.verdict !== "inconclusive") break;
    if (attempt < RETRY) await sleep(res.status === 429 ? 45000 : 10000);
  }
  return { id: `${t.pid}/${t.model}`, provider: t.pid, label: t.label, ...last };
}

async function main() {
  const targets = loadTargets();
  if (!targets.length) {
    console.error("providers.json 里没有可测的 staticModels");
    process.exit(2);
  }
  log(`probe-tools: ${targets.length} 个模型 …`);

  // 按来源分组：组内串行（避免同来源并发触发限流），组间并行
  const groups = new Map();
  for (const t of targets) {
    if (!groups.has(t.pid)) groups.set(t.pid, []);
    groups.get(t.pid).push(t);
  }

  const models = [];
  await Promise.all(
    [...groups.entries()].map(async ([pid, list]) => {
      for (const t of list) {
        const r = await probeOne(t);
        models.push(r);
        const tag = { tools_confirmed: "OK   ", tools_text: "TEXT ", tools_rejected: "NO   ", model_missing: "GONE ", text_only: "PLAIN", inconclusive: "UNK  " }[r.verdict] || "?";
        log(`  [${tag}] ${r.id}  ${r.detail}`);
        await sleep(1200);
      }
    })
  );
  models.sort((a, b) => a.id.localeCompare(b.id));

  const count = (v) => models.filter((m) => m.verdict === v).length;
  const snap = {
    generatedAt: new Date().toISOString(),
    env: ENV_LABEL,
    summary: {
      checked: models.length,
      confirmed: count("tools_confirmed"),
      text: count("tools_text"),
      rejected: count("tools_rejected"),
      missing: count("model_missing"),
      plain: count("text_only"),
      inconclusive: count("inconclusive"),
    },
    models,
  };

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(snap, null, 2) + "\n", "utf8");

  log(`\n快照写入 ${path.relative(ROOT, OUT)}  [环境: ${ENV_LABEL}]`);
  log(`确认 ${snap.summary.confirmed}/${snap.summary.checked} 支持工具调用` +
      (snap.summary.text ? `，${snap.summary.text} 文本格式` : "") +
      (snap.summary.rejected ? `，${snap.summary.rejected} 明确不支持` : "") +
      (snap.summary.missing ? `，${snap.summary.missing} 模型已失效` : "") +
      (snap.summary.inconclusive ? `，${snap.summary.inconclusive} 未定` : ""));

  // 不因限流/未定而 fail；只有「确认不支持」与「模型失效」值得让 CI 亮黄灯
  const bad = models.filter((m) => m.verdict === "tools_rejected" || m.verdict === "model_missing");
  if (bad.length) {
    log(`\n⚠ 需要人工复核：`);
    for (const b of bad) log(`   ${b.id}  ${b.verdict}  ${b.detail}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
