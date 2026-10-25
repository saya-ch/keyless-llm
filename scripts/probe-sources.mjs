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

  const snap = {
    generatedAt: new Date().toISOString(),
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

  log(`\n快照写入 ${path.relative(ROOT, OUT)}`);
  log(`总计 ${snap.summary.healthy}/${snap.summary.freeModels} 可用` +
      (snap.summary.limited ? `，${snap.summary.limited} 限流` : "") +
      (snap.summary.blocked ? `，${snap.summary.blocked} 封禁` : "") +
      (snap.summary.failed ? `，${snap.summary.failed} 异常` : ""));

  // 全部来源都挂掉时返回非零，让 CI 报警
  if (snap.summary.healthy === 0) process.exitCode = 1;
}

main().catch((e) => { console.error(e); process.exit(1); });
