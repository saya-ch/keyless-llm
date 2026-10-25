#!/usr/bin/env node
/**
 * probe-sources.mjs — 来源可用性确定性探测（CI / 定时任务用）
 *
 * 职责边界（重要）：
 *   本脚本只做「已登记来源今天还能不能用」的判定，是纯确定性的，不做搜索、不做判断。
 *   发现新的免鉴权来源是 agent 的活儿（见 .github/workflows/discover.yml 与 README「自动化」一节）。
 *
 * 输出：snapshots/status.json
 *   { generatedAt, providers: [{ id, label, modelsFound, freeModels, ok, limited, blocked, failed, models: [...] }] }
 *
 * 用法：
 *   node scripts/probe-sources.mjs [--out snapshots/status.json] [--timeout 15000] [--quiet]
 * 环境变量：
 *   KEYLESS_PROBE_TIMEOUT   单次请求超时（毫秒）
 *   KEYLESS_PROBE_SLEEP     每个模型之间的间隔（毫秒），默认 800
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const argv = process.argv.slice(2);
const arg = (k, d) => {
  const i = argv.indexOf(k);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};
const has = (k) => argv.includes(k);

const TIMEOUT = parseInt(arg("--timeout", process.env.KEYLESS_PROBE_TIMEOUT || "15000"), 10);
const SLEEP = parseInt(arg("--sleep", process.env.KEYLESS_PROBE_SLEEP || "800"), 10);
const OUT = path.resolve(ROOT, arg("--out", "snapshots/status.json"));
const QUIET = has("--quiet");
const UA = "keyless-llm-probe/1.0";

// 探测环境：CI 的共享出口 IP 容易被免费来源按 IP 限流，
// 所以 CI 上的失败**不能**等同于来源死亡 —— 快照里必须标注来源，
// 判定"来源已死"需要连续多天失败，见 README「防误报」一节。
const ENV_LABEL = process.env.KEYLESS_PROBE_ENV
  || (process.env.CI ? "ci" : "local");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => { if (!QUIET) console.log(...a); };

// ── 来源配置 ──────────────────────────────────────────────────────
function loadProviders() {
  const file = path.join(ROOT, "providers.json");
  let cfg = { providers: [] };
  try {
    cfg = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    console.error(`providers.json 读取失败: ${e.message}`);
    process.exit(2);
  }
  return (cfg.providers || []).map((p) => ({
    modelsPath: "/models",
    staticModels: [],
    extraFree: [],
    ...p,
    label: p.label || p.id,
    base: String(p.base || "").replace(/\/+$/, ""),
  }));
}

function isFreeModel(p, m) {
  const id = String(m.id || m.name || "");
  if ((p.extraFree || []).includes(id)) return true;
  const r = p.freeRule || { type: "all" };
  if (r.type === "all") return true;
  if (r.type === "suffix") return id.endsWith(r.value);
  if (r.type === "prefix") return id.startsWith(r.value);
  if (r.type === "contains") return id.includes(r.value);
  if (r.type === "field") return String(m[r.field]) === String(r.value);
  return false;
}

function listModels(j) {
  if (Array.isArray(j)) return j;
  if (Array.isArray(j.data)) return j.data;
  if (Array.isArray(j.models)) return j.models;
  if (j && typeof j === "object") return Object.values(j).filter((v) => v && typeof v === "object" && (v.id || v.name));
  return [];
}

// ── HTTP ──────────────────────────────────────────────────────────
async function httpJson(url, opts = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeout || TIMEOUT);
  try {
    const res = await fetch(url, {
      method: opts.method || "GET",
      headers: { "User-Agent": UA, ...(opts.headers || {}) },
      body: opts.body,
      signal: ctrl.signal,
    });
    let json = null;
    try { json = await res.json(); } catch { /* 非 JSON，忽略 */ }
    return { status: res.status, json, ok: res.ok };
  } catch (e) {
    return { status: -1, json: null, ok: false, error: e.name === "AbortError" ? "TIMEOUT" : e.message };
  } finally {
    clearTimeout(timer);
  }
}

// ── 探测 ──────────────────────────────────────────────────────────
// 轻探测：max_tokens=1，只判定 200/429/403/5xx，不读响应体
async function probeModel(p, model) {
  const r = await httpJson(`${p.base}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, messages: [{ role: "user", content: "hi" }], max_tokens: 1, stream: false }),
  });
  let err = "";
  if (!r.ok && r.json) err = r.json.error?.message || r.json.error?.type || r.json.type || "";
  const state = r.status === 200 ? "healthy"
    : r.status === 429 ? "limited"
    : r.status === 403 ? "blocked"
    : r.status >= 500 || r.status === -1 ? "limited"
    : "unknown";
  return { model, status: r.status, state, error: err || (r.error || "") };
}

// ── 主流程 ────────────────────────────────────────────────────────
async function probeProvider(p) {
  const found = new Map();          // modelId -> 模型元信息
  let modelsError = "";

  // 1) 拉 live /models（discover:false 的来源只用 staticModels）
  if (p.discover !== false) {
    const r = await httpJson(p.base + (p.modelsPath || "/models"));
    if (r.ok && r.json) {
      for (const m of listModels(r.json)) {
        const id = String(m.id || m.name || "").trim();
        if (id) found.set(id, m);
      }
    } else {
      // 拉不到就退回静态清单，但要在快照里如实标注
      modelsError = `models ${r.status}${r.error ? " " + r.error : ""}`;
    }
  }

  // 2) 合并 staticModels 兜底
  for (const m of p.staticModels || []) {
    if (!found.has(m)) found.set(m, { id: m });
  }

  // 3) 挑出免费模型
  const free = [...found.entries()]
    .filter(([, m]) => isFreeModel(p, m))
    .map(([id]) => id);

  const results = [];
  for (const m of free) {
    const r = await probeModel(p, m);
    results.push(r);
    if (!QUIET) {
      const tag = { healthy: "OK  ", limited: "LIMIT", blocked: "BLOCK", unknown: "ERR " }[r.state];
      log(`  [${tag}] ${p.id}/${m}${r.error ? "  " + String(r.error).slice(0, 80) : ""}`);
    }
    if (SLEEP > 0) await sleep(SLEEP);
  }

  const count = (s) => results.filter((r) => r.state === s).length;
  return {
    id: p.id,
    label: p.label,
    enabled: !!p.enabled,
    base: p.base,
    rate: p.rate || "",
    modelsError: p.discover === false ? "" : modelsError,
    modelsFound: found.size,
    freeModels: free.length,
    ok: count("healthy"),
    limited: count("limited"),
    blocked: count("blocked"),
    failed: count("unknown"),
    models: results.map((r) => ({ model: r.model, status: r.status, state: r.state, error: r.error || "" })),
  };
}

async function main() {
  const providers = loadProviders().filter((p) => p.enabled);
  if (!providers.length) {
    console.error("providers.json 中没有 enabled 的来源");
    process.exit(2);
  }
  log(`probe ${providers.length} 个来源 …`);

  const out = [];
  for (const p of providers) {
    log(`\n[${p.id}] ${p.label}  ${p.base}`);
    try {
      out.push(await probeProvider(p));
    } catch (e) {
      log(`  [ERR ] ${p.id}: ${e.message}`);
      out.push({ id: p.id, label: p.label, enabled: true, base: p.base, modelsFound: 0, freeModels: 0, ok: 0, limited: 0, blocked: 0, failed: 0, error: e.message, models: [] });
    }
  }

  // ── 连续失败计数（防误报）─────────────────────────────────────
  // 读上一次快照，对每个来源累计「本轮没有任何可用模型」的次数。
  // 只有连续 N 次全失败才建议标记 dead —— 单次失败（尤其是 CI 上）
  // 很可能只是出口 IP 被限流，而不是来源真的消失了。
  const DEAD_THRESHOLD = parseInt(process.env.KEYLESS_DEAD_THRESHOLD || "3", 10);
  let prev = null;
  try { prev = JSON.parse(fs.readFileSync(OUT, "utf8")); } catch { /* 首次运行没有历史 */ }
  const prevStreak = {};
  if (prev?.providers) {
    for (const p of prev.providers) prevStreak[p.id] = p.failStreak || 0;
  }

  for (const p of out) {
    const allDown = p.freeModels > 0 && p.ok === 0;
    p.failStreak = allDown ? (prevStreak[p.id] || 0) + 1 : 0;
    // 达到阈值才建议标记死亡；CI 环境下要求更高（更容易是 IP 问题）
    const threshold = ENV_LABEL === "ci" ? DEAD_THRESHOLD + 2 : DEAD_THRESHOLD;
    p.suggestDead = p.failStreak >= threshold;
  }

  const snap = {
    generatedAt: new Date().toISOString(),
    env: ENV_LABEL,
    summary: {
      providers: out.length,
      freeModels: out.reduce((a, x) => a + x.freeModels, 0),
      healthy: out.reduce((a, x) => a + x.ok, 0),
      limited: out.reduce((a, x) => a + x.limited, 0),
      blocked: out.reduce((a, x) => a + x.blocked, 0),
      failed: out.reduce((a, x) => a + x.failed, 0),
    },
    providers: out,
  };

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(snap, null, 2) + "\n", "utf8");

  log(`\n快照写入 ${path.relative(ROOT, OUT)}  [环境: ${ENV_LABEL}]`);
  log(`总计 ${snap.summary.healthy}/${snap.summary.freeModels} 可用` +
      (snap.summary.limited ? `，${snap.summary.limited} 限流` : "") +
      (snap.summary.blocked ? `，${snap.summary.blocked} 封禁` : "") +
      (snap.summary.failed ? `，${snap.summary.failed} 异常` : ""));

  const dying = out.filter((p) => p.suggestDead);
  if (dying.length) {
    log(`\n⚠ 连续失败已达阈值，建议复核是否真的失效：`);
    for (const p of dying) log(`   ${p.id} 连续 ${p.failStreak} 轮无可用模型`);
  }
  // 单次全失败不报警：很可能是出口 IP 被限流，不是来源真死
  if (snap.summary.healthy === 0 && dying.length) process.exitCode = 1;
}

main().catch((e) => { console.error(e); process.exit(1); });
