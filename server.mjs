/**
 * free-llm-gateway — 免鉴权免费大模型聚合网关
 * 来源：Kilo Code / Pollinations / BlockRun / OpenCode ...（见 providers.json）
 * 对外：OpenAI Chat Completions / Anthropic Messages / OpenAI Responses
 * 特性：多来源聚合、provider/model 命名空间、按来源隔离的冷却状态机、跨来源 failover
 * 探测：轻探测（max_tokens=1，只判可用性）与 TPS 测速（真生成）完全分开
 * 用法：node server.mjs   （面板见 launch.ps1）
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const VERSION = "2.0.0";

// ── 配置 ──────────────────────────────────────────────────────────
// 环境变量：KEYLESS_* 优先，兼容旧的 OC2FREE_*（改名前的历史配置不必改）
const env = (k, d) => process.env[`KEYLESS_${k}`] ?? process.env[`OC2FREE_${k}`] ?? d;

const CFG = {
  port: int(process.env.PORT, 8788),
  host: process.env.HOST || "127.0.0.1",
  serverKey: env("KEY", "sk-keyless-local"),
  ua: env("UA", "keyless-llm/1.0"),
  cooldown429: int(env("CD429", 600), 600),      // 秒；限流冷却
  cooldown403: int(env("CD403", 3600), 3600),    // 秒；封禁冷却
  // 探测默认关闭：免费来源的配额按请求数计，主动探测本身就在烧额度
  // （31 个模型 × 每 30 分钟 = 62 次/小时，Kilo 的 200/h 配额三分之一没了）。
  // 更优雅的做法是被动学习：真请求成功即标可用、429 即标限流，
  // 未用过的模型显示「待验证」，auto 会按评分顺序试，撞到限流就换下一个。
  // 需要全景时再手动探测（Web 控制台按钮 / POST /v1/probe）。
  probeSeconds: int(env("PROBE", 0), 0),        // 秒；0=关闭定时探测
  probeOnStart: int(env("PROBE_ON_START", 0), 0), // 1=启动时探一轮（会消耗额度）
  modelsRefresh: int(env("MODELS_TTL", 1800), 1800),
  logDir: env("LOGDIR", path.join(__dirname, "logs")),
  catalogPath: env("CATALOG", path.join(__dirname, "models.catalog.json")),
  providersPath: env("PROVIDERS", path.join(__dirname, "providers.json")),
  maxAttempts: int(env("ATTEMPTS", 2), 2),       // 含首次，最多转移次数
  // ── auto 伪模型 ────────────────────────────────────────────────
  autoNames: (env("AUTO_NAMES", "auto,auto-fast,auto-thinking") || "auto").split(",").map((s) => s.trim()).filter(Boolean),
  autoAttempts: int(env("AUTO_ATTEMPTS", 6), 6),  // auto 模式最多试几个模型
  autoSticky: int(env("AUTO_STICKY", 1), 1),       // 成功过的模型是否优先复用（会话亲和）
  // ── auto 质量准入 ──────────────────────────────────────────────
  // 过于拉跨的模型（小上下文、无工具调用）不进 auto 池，
  // 但通过显式模型名仍可访问；全不合格时降级放行，保证 auto 永不空转。
  autoMinCtx: int(env("AUTO_MIN_CTX", 256000), 256000),   // 最低上下文（默认 256k）
  autoRequireTools: int(env("AUTO_REQUIRE_TOOLS", 1), 1), // 要求工具调用（agent）能力
  // 防限流：免费配额普遍按 IP 计，同一来源打太多并发只会把自己打爆。
  // providerConcurrency 限制单来源在途请求数，超出的排队（队列也满则放弃该来源换模型）。
  providerConcurrency: int(env("PROVIDER_CONCURRENCY", 3), 3),
  // 超时（毫秒）：auto 模式单次请求更快失败好换模型；普通模式留足生成时间
  timeout: int(env("TIMEOUT", 120000), 120000),
  timeoutStream: int(env("TIMEOUT_STREAM", 300000), 300000),
  autoTimeout: int(env("AUTO_TIMEOUT", 45000), 45000),   // auto 模式单模型超时
};
function int(v, d) { const n = parseInt(v, 10); return Number.isFinite(n) ? n : d; }

// 无 -free 后缀但标价为 0 的模型（内嵌目录 cost=0）
const FREE_NOSUFFIX = new Set(["big-pickle", "beam-free", "grok-code"]);

// ── 模型目录与状态 ────────────────────────────────────────────────
let providers = [];                     // [{id,label,base,rate,freeRule,...}]
const registry = new Map();             // key `${pid}/${model}` -> {pid, model, free, name, context, output}
const state = new Map();                // key -> {state, stateAt, cooldownUntil, lastError, tps, ttft, lastUsedAt}
const stats = { requests: 0, failovers: 0, tokensIn: 0, tokensOut: 0, startedAt: Date.now() };
let lastProbeAt = 0, lastModelsAt = 0, probing = false;

// ── 来源配置 ──────────────────────────────────────────────────────
function loadProviders() {
  let cfg = { providers: [] };
  try {
    cfg = JSON.parse(fs.readFileSync(CFG.providersPath, "utf8"));
  } catch (e) {
    log("error", `providers.json 读取失败: ${e.message}`);
  }
  providers = (cfg.providers || []).map((p) => ({
    enabled: true,
    modelsPath: "/models",
    staticModels: [],
    extraFree: [],
    ...p,
    label: p.label || p.id,
    base: String(p.base || "").replace(/\/+$/, ""),
  }));
  for (const p of providers) for (const m of p.staticModels) addModel(p, typeof m === "string" ? { id: m } : m);
  log("info", `providers: ${providers.filter((p) => p.enabled).length}/${providers.length} enabled, models=${registry.size}`);
}

function providerEnabled(pid) {
  const p = providers.find((x) => x.id === pid);
  return !!p && p.enabled;
}
function providerOf(key) {
  const pid = key.slice(0, key.indexOf("/"));
  return providers.find((p) => p.id === pid) || null;
}
function keyOf(pid, model) { return `${pid}/${model}`; }
function modelOf(key) { return key.slice(key.indexOf("/") + 1); }

// 各来源的"免费"判定规则不同：Kilo 靠 :free 后缀，Pollinations 靠 tier 字段，BlockRun 靠前缀
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

function addModel(p, m) {
  const mid = String(m.id || m.name || "").trim();
  if (!mid) return null;
  const key = keyOf(p.id, mid);
  const ctx = m.context_length || m.context || (m.limit && m.limit.context) || (m.top_provider && m.top_provider.max_completion_tokens && m.top_provider.context_length) || (m.top_provider && m.top_provider.context_length) || null;
  const out = m.max_output || (m.limit && m.limit.output) || (m.top_provider && m.top_provider.max_completion_tokens) || null;
  // 工具调用（agent 能力）检测：OpenRouter 系 /models 用 supported_parameters 数组，
  // 其它实现可能用 capabilities.tools / tools 布尔字段。
  // 三态：true（确认支持）/ false（确认不支持）/ null（未知，staticModels 兜底进来时）
  const sp = m.supported_parameters || m.supportedParameters || [];
  const caps = m.capabilities || {};
  const tools = (Array.isArray(sp) && (sp.includes("tools") || sp.includes("tool_choice")))
    || caps.tools === true || m.tools === true
    ? true
    : (Array.isArray(sp) && sp.length && !sp.includes("tools") && !sp.includes("tool_choice")) || caps.tools === false
      ? false
      : null;
  if (!registry.has(key)) {
    registry.set(key, { pid: p.id, model: mid, free: isFreeModel(p, m), name: mid, context: ctx, output: out, tools });
    ensureState(key);
  } else {
    const e = registry.get(key);
    if (ctx && !e.context) e.context = ctx;
    if (out && !e.output) e.output = out;
    if (tools !== null && e.tools === null) e.tools = tools;   // live 元数据补齐静态清单的未知
  }
  return key;
}

function ensureState(key) {
  if (!state.has(key)) state.set(key, { state: "unknown", stateAt: 0, cooldownUntil: 0, lastError: "", tps: null, ttft: null, lastUsedAt: 0 });
  return state.get(key);
}
function freeEntries() {
  return [...registry.entries()].filter(([k, e]) => e.free && providerEnabled(e.pid));
}
function freeKeys() { return freeEntries().map(([k]) => k); }

// /models 的返回格式各来源不一：{data:[]} / 数组 / {models:[]} / 以 id 为键的对象
function listModels(j) {
  if (Array.isArray(j)) return j;
  if (Array.isArray(j.data)) return j.data;
  if (Array.isArray(j.models)) return j.models;
  if (j && typeof j === "object") return Object.values(j).filter((v) => v && typeof v === "object" && (v.id || v.name));
  return [];
}

// 遍历各来源拉 live /models，结果并入注册表（静态清单已在启动时载入兜底）
async function refreshModels(force = false) {
  if (!force && lastModelsAt && Date.now() - lastModelsAt < CFG.modelsRefresh * 1000) return;
  let added = 0;
  for (const p of providers.filter((x) => x.enabled)) {
    if (p.discover === false) continue; // 只认 staticModels（如 BlockRun 免费/付费混在同一 /models 里）
    try {
      const res = await fetch(p.base + p.modelsPath, { headers: { "User-Agent": CFG.ua } });
      if (!res.ok) throw new Error(`models ${res.status}`);
      const j = await res.json();
      for (const m of listModels(j)) {
        const before = registry.size;
        addModel(p, m);
        if (registry.size > before) added++;
      }
    } catch (e) {
      log("warn", `models ${p.id}: ${e.message}`);
    }
  }
  lastModelsAt = Date.now();
  log("info", `models refreshed: ${registry.size} total, +${added} new, free=${freeKeys().length}`);
}

// ── 状态机 ────────────────────────────────────────────────────────
// status 约定：HTTP 状态码；-1 表示网络异常；
// 特殊值 200 表示「HTTP 成功但内容为空」，按降级处理（不算健康）
// cdOverride：上游 Retry-After 给出的冷却秒数，优先于固定值
function markResult(id, status, errMsg, cdOverride = 0) {
  const st = ensureState(id);
  st.stateAt = Date.now();
  if (status === 200) {
    if (st.state !== "healthy") log("info", `model ${id}: -> healthy`);
    st.state = "healthy"; st.cooldownUntil = 0; st.lastError = "";
  } else if (status === 429) {
    const cd = cdOverride > 0 ? Math.min(cdOverride, 3600) : CFG.cooldown429;
    if (st.state !== "limited") log("info", `model ${id}: -> limited (429) cd=${cd}s${cdOverride ? " (retry-after)" : ""}`);
    st.state = "limited"; st.cooldownUntil = Date.now() + cd * 1000; st.lastError = errMsg || "429";
  } else if (status === 403) {
    if (st.state !== "blocked") log("info", `model ${id}: -> blocked (403) cd=${CFG.cooldown403}s`);
    st.state = "blocked"; st.cooldownUntil = Date.now() + CFG.cooldown403 * 1000; st.lastError = errMsg || "403";
  } else if (status >= 500) {
    st.state = "limited"; st.cooldownUntil = Date.now() + 60 * 1000; st.lastError = `${status}`;
  } else if (status !== -1) {
    st.state = "unknown"; st.lastError = `${status} ${errMsg || ""}`.trim();
  }
}

// 空响应专用标记：HTTP 200 但没内容 —— 模型能连上，只是这次没产出
// 不算 healthy，但也不该进长冷却（换个模型可能就好了）
function markEmpty(id, msg) {
  const st = ensureState(id);
  st.stateAt = Date.now();
  st.lastError = msg || "empty_response";
  if (st.state === "healthy") st.state = "unknown";
}
function available(key) {
  const st = ensureState(key);
  return st.state === "healthy" || st.state === "unknown" || Date.now() >= st.cooldownUntil;
}

// 把用户传的模型名解析成注册表 key，支持三种写法：
//   1. 完整 key       kilo/reflection/beam-free
//   2. 裸模型名       reflection/beam-free 或 beam-free
//   3. 后缀别名       beam-free  →  reflection/beam-free
function resolveKey(requested) {
  if (!requested) return null;
  const want = String(requested);
  // auto 是伪模型，不在注册表里，必须提前返回，
  // 否则会误匹配到名字里含 "auto" 的真实模型（如 kilo-auto/free）
  if (isAutoName(want)) return null;
  if (registry.has(want)) return want;
  const keys = freeKeys();
  const exact = keys.filter((k) => modelOf(k) === want);
  if (exact.length) return exact.find(available) || exact[0];
  const alias = keys.filter((k) => {
    const m = modelOf(k);
    return m.endsWith("/" + want) || m.includes(want);
  });
  if (alias.length) return alias.find(available) || alias[0];
  return null;
}

// 用户传的名字本身就是这个模型（完整 key / 裸名 / 后缀别名）时，不算"转移"
function isAliasOf(key, requested) {
  if (!requested) return false;
  const m = modelOf(key);
  return key === requested || m === requested || m.endsWith("/" + requested) || m.includes(requested);
}

function pickModel(requested) {
  const hit = resolveKey(requested);
  if (hit && available(hit)) return { key: hit, failover: !isAliasOf(hit, requested) };

  // 需要转移：同来源优先（通常限流按来源计），再跨来源
  const hitPid = hit ? registry.get(hit).pid : (requested && requested.includes("/") ? requested.split("/")[0] : null);
  const ordered = freeKeys()
    .filter(available)
    .sort((a, b) => ensureState(a).lastUsedAt - ensureState(b).lastUsedAt);
  const samePid = hitPid ? ordered.filter((k) => registry.get(k).pid === hitPid) : [];
  const chosen = samePid[0] || ordered[0] || null;

  if (!chosen) {
    const keys = freeKeys();
    return { key: hit || keys[0] || null, failover: false };
  }
  return { key: chosen, failover: chosen !== requested };
}

// ── auto 伪模型 ────────────────────────────────────────────────────
// 客户端传 model="auto"，网关自己挑一个当下最靠谱的模型；
// 失败（限流/封禁/上游错误）自动换下一个模型重试，直到成功或试完。
//
// 为什么要它：免费来源的可用性是动态的。客户端写死 "beam-free"，
// 那个模型一旦被限流，整条链路就断了，只能等冷却结束。
// auto 把「选模型」这件事交给网关，让调用方永远只关心「能不能通」。

function isAutoName(requested) {
  if (!requested) return false;
  return CFG.autoNames.includes(String(requested).trim().toLowerCase());
}

// 给模型打分，分数越高越优先被 auto 选中
// 维度：健康状态 > 实测 TPS > 上下文长度 > 冷却剩余 > 最近使用时间
function scoreModel(key) {
  const e = registry.get(key);
  const st = ensureState(key);
  if (!e) return -Infinity;

  let score = 0;

  // 1) 健康状态：healthy 远好于 unknown（未探测），limited/blocked 最低
  if (st.state === "healthy") score += 1000;
  else if (st.state === "unknown") score += 400;
  else score += 50;

  // 2) 实测 TPS：测过的模型优先，且 TPS 越高越好（归一化到 0~200）
  if (st.tps && st.tps > 0) {
    score += Math.min(200, st.tps * 10);
    // 首字延迟也纳入：越低越好
    if (st.ttft && st.ttft > 0) score += Math.max(0, 100 - st.ttft / 50);
  }

  // 3) 上下文长度：长上下文更通用（归一化到 0~150，1M 拿满分）；未知 ctx 略降权
  if (e.context) score += Math.min(150, Math.log10(e.context / 1000 + 1) * 60);
  else score -= 100;

  // 3.5) agent 能力：确认支持工具调用加分；未知不奖不罚
  if (e.tools === true) score += 50;

  // 4) 冷却剩余时间：冷却中的模型分数要低，但不为 0（万一马上解冻）
  if (st.cooldownUntil > Date.now()) {
    const remain = (st.cooldownUntil - Date.now()) / 1000;
    score -= Math.min(300, remain / 2);
  }

  // 5) 最近使用时间：久未使用的优先，避免单个模型被反复消耗（轮转）
  const idle = Date.now() - (st.lastUsedAt || 0);
  score += Math.min(80, idle / 60000);

  return score;
}

// 选出当前最优的模型；exclude 是本次请求已试过、要跳过的 key
// auto 质量准入：先在「合格池」里挑（ctx≥autoMinCtx 且支持工具调用），
// 合格池为空才降级到全量候选 —— 宁可调度到弱模型，也不让 auto 直接失败
function autoEligible(key) {
  const e = registry.get(key);
  if (!e) return false;
  if (e.context && e.context < CFG.autoMinCtx) return false;        // 上下文太小
  if (CFG.autoRequireTools && e.tools === false) return false;      // 确认无 agent 能力
  return true;                                                      // ctx/tools 未知的不误杀，靠评分降权
}

function pickAutoModel(exclude = new Set()) {
  const all = freeKeys().filter((k) => available(k) && !exclude.has(k));
  const eligible = all.filter(autoEligible);
  const pool = eligible.length ? eligible : all;
  pool.sort((a, b) => scoreModel(b) - scoreModel(a));
  return pool[0] || null;
}

// auto 模式下的一次尝试：返回被选中的 key
// preferUsed 开启时优先复用上次成功的模型（会话亲和，减少来回切换）
let lastAutoKey = null;
function pickAuto(preferUsed = false) {
  if (CFG.autoSticky && preferUsed && lastAutoKey && available(lastAutoKey)) {
    return lastAutoKey;
  }
  return pickAutoModel(new Set());
}

// ── 探测（花额度，默认 30 分钟一次；面板 R 键手动全量）──────────────
// 轻探测：max_tokens=1，只判 200/429/403，成功时不读响应体（不产生实际用量）
async function probeModel(key) {
  const e = registry.get(key);
  const p = e && providerOf(key);
  if (!p) { markResult(key, -1, "no provider"); return -1; }
  try {
    const res = await fetch(`${p.base}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": CFG.ua },
      body: JSON.stringify({ model: e.model, messages: [{ role: "user", content: "hi" }], max_tokens: 1, stream: false }),
    });
    let msg = "";
    if (!res.ok) {
      try { const j = await res.json(); msg = j.error?.message || j.error?.type || j.type || ""; } catch {}
    } else {
      try { await res.body?.cancel(); } catch {}
    }
    markResult(key, res.status, msg);
    return res.status;
  } catch (e2) {
    markResult(key, -1, e2.message);
    return -1;
  }
}
// 「待验证」的模型在冷却期内不重复探测：免费来源普遍按请求次数限流
// （Kilo 200 次/小时），无脑重探会把自己的额度吃光。
const PROBE_SKIP_UNKNOWN_MS = 30 * 60 * 1000;

// 轻探测：每个模型发一次 max_tokens=1 的请求，只读状态码不读内容。
// 注意这仍然消耗上游配额（一次请求就是一次），所以默认不开启，
// 只在用户手动触发时执行；且支持 limit 上限，避免一次烧掉几十分钟配额。
async function probeAll(force = false, limit = 0) {
  if (probing) return { probed: 0, reason: "busy" };
  probing = true;
  try {
    let keys = freeKeys().filter((k) => {
      if (force) return true;
      if (!available(k)) return false;
      const st = ensureState(k);
      if (st.state === "unknown" && Date.now() - (st.stateAt || 0) < PROBE_SKIP_UNKNOWN_MS) return false;
      return true;
    });
    if (limit > 0) keys = keys.slice(0, limit);
    log("info", `probe ${keys.length} free models${force ? " (force)" : ""}${limit ? ` limit=${limit}` : ""}`);
    for (const k of keys) { await probeModel(k); await sleep(500); }
    lastProbeAt = Date.now();
    return { probed: keys.length };
  } finally { probing = false; }
}

// ── 上游调用 ──────────────────────────────────────────────────────
class UpstreamError extends Error {
  constructor(status, type, message, model) { super(message); this.status = status; this.type = type; this.model = model; }
}

// ── 来源协议适配层 ────────────────────────────────────────────────
// 对外统一三种协议（OpenAI Chat / Anthropic Messages / OpenAI Responses），
// 内部以 OpenAI Chat 为 pivot。每个来源在 providers.json 里声明 api 字段：
//   "openai-completions"（默认）  —— 直通，零转换
//   "anthropic-messages"          —— 请求/响应/SSE 三路转换
//   "openai-responses"            —— 请求/响应/SSE 三路转换
// 网关的价值就在这里：客户端永远只学一种协议，来源爱说什么就说什么。

// OpenAI Chat 请求 → Anthropic Messages 请求
function openAIToAnthropic(oai, model) {
  const sys = [];
  const msgs = [];
  for (const m of oai.messages ?? []) {
    if (m.role === "system" || m.role === "developer") { sys.push(typeof m.content === "string" ? m.content : JSON.stringify(m.content)); continue; }
    if (m.role === "tool") {
      msgs.push({ role: "user", content: [{ type: "tool_result", tool_use_id: m.tool_call_id, content: typeof m.content === "string" ? m.content : JSON.stringify(m.content) }] });
      continue;
    }
    const content = typeof m.content === "string"
      ? m.content
      : (Array.isArray(m.content) ? m.content.map((c) => (c.type === "text" ? { type: "text", text: c.text } : null)).filter(Boolean) : "");
    if (m.role === "assistant" && Array.isArray(m.tool_calls) && m.tool_calls.length) {
      const blocks = [];
      if (typeof content === "string") { if (content) blocks.push({ type: "text", text: content }); }
      else if (Array.isArray(content)) blocks.push(...content);
      for (const tc of m.tool_calls) blocks.push({ type: "tool_use", id: tc.id, name: tc.function?.name, input: safeJson(tc.function?.arguments) ?? {} });
      msgs.push({ role: "assistant", content: blocks });
      continue;
    }
    msgs.push({ role: m.role, content });
  }
  const out = { model, max_tokens: oai.max_tokens ?? 1024, messages: msgs };
  if (sys.length) out.system = sys.join("\n\n");
  if (oai.temperature != null) out.temperature = oai.temperature;
  if (oai.top_p != null) out.top_p = oai.top_p;
  if (oai.stop) out.stop_sequences = Array.isArray(oai.stop) ? oai.stop : [oai.stop];
  if (Array.isArray(oai.tools) && oai.tools.length) {
    out.tools = oai.tools.map((t) => ({ name: t.function?.name, description: t.function?.description || "", input_schema: t.function?.parameters || { type: "object" } }));
  }
  if (oai.tool_choice) {
    const tc = oai.tool_choice;
    if (tc === "auto") out.tool_choice = { type: "auto" };
    else if (tc === "none") delete out.tools;
    else if (tc?.function?.name) out.tool_choice = { type: "tool", name: tc.function.name };
  }
  return out;
}

// Anthropic 响应 → OpenAI Chat 响应（pivot 反向）
function anthropicToOpenAIResponse(j) {
  const text = [], thinking = [], toolCalls = [];
  for (const b of j.content ?? []) {
    if (b.type === "text") text.push(b.text);
    else if (b.type === "thinking") thinking.push(b.thinking);
    else if (b.type === "tool_use") toolCalls.push({ id: b.id, type: "function", function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) } });
  }
  const finish = j.stop_reason === "max_tokens" ? "length" : (j.stop_reason === "tool_use" ? "tool_calls" : "stop");
  return {
    id: j.id || "anthropic", object: "chat.completion", model: j.model,
    choices: [{
      index: 0,
      message: { role: "assistant", content: text.join("") || "", ...(thinking.length ? { reasoning_content: thinking.join("") } : {}), ...(toolCalls.length ? { tool_calls: toolCalls } : {}) },
      finish_reason: finish,
    }],
    usage: { prompt_tokens: j.usage?.input_tokens ?? 0, completion_tokens: j.usage?.output_tokens ?? 0 },
  };
}

// Anthropic SSE 事件流 → OpenAI chunk 流（供三个 handler 统一消费）
async function* anthropicSSEToChunks(up) {
  const reader = up.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let blockKind = null;   // 当前打开的 block 类型
  let tcIndex = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (!data || data === "[DONE]") continue;
        let ev; try { ev = JSON.parse(data); } catch { continue; }
        const base = { id: ev.message?.id || "anthropic", object: "chat.completion.chunk", model: ev.message?.model };
        if (ev.type === "content_block_start") {
          blockKind = ev.content_block?.type || null;
          if (blockKind === "tool_use") {
            yield { chunk: { ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: tcIndex, id: ev.content_block.id, type: "function", function: { name: ev.content_block.name, arguments: "" } }] }, finish_reason: null }] } };
          } else if (blockKind === "text") {
            yield { chunk: { ...base, choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] } };
          }
        } else if (ev.type === "content_block_delta") {
          const d = ev.delta || {};
          if (d.type === "text_delta") yield { chunk: { ...base, choices: [{ index: 0, delta: { content: d.text }, finish_reason: null }] } };
          else if (d.type === "thinking_delta") yield { chunk: { ...base, choices: [{ index: 0, delta: { reasoning_content: d.thinking }, finish_reason: null }] } };
          else if (d.type === "input_json_delta") yield { chunk: { ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: tcIndex, function: { arguments: d.partial_json || "" } }] }, finish_reason: null }] } };
        } else if (ev.type === "content_block_stop") {
          if (blockKind === "tool_use") tcIndex++;
          blockKind = null;
        } else if (ev.type === "message_delta") {
          const fr = ev.delta?.stop_reason === "max_tokens" ? "length" : (ev.delta?.stop_reason === "tool_use" ? "tool_calls" : "stop");
          yield { chunk: { ...base, choices: [{ index: 0, delta: {}, finish_reason: fr }], ...(ev.usage ? { usage: { prompt_tokens: ev.usage.input_tokens ?? 0, completion_tokens: ev.usage.output_tokens ?? 0 } } : {}) } };
        } else if (ev.type === "message_stop") {
          yield { done: true };
          return;
        }
      }
    }
  } finally {
    try { clearTimeout(up.__keylessTimer); } catch {}
  }
}

// OpenAI Chat 请求 → OpenAI Responses 请求
function openAIToResponses(oai, model) {
  const sys = [];
  const input = [];
  for (const m of oai.messages ?? []) {
    if (m.role === "system" || m.role === "developer") { sys.push(typeof m.content === "string" ? m.content : JSON.stringify(m.content)); continue; }
    input.push({ role: m.role, content: [{ type: m.role === "assistant" ? "output_text" : "input_text", text: typeof m.content === "string" ? m.content : JSON.stringify(m.content) }] });
  }
  const out = { model, input };
  if (sys.length) out.instructions = sys.join("\n\n");
  if (oai.max_tokens != null) out.max_output_tokens = oai.max_tokens;
  if (oai.temperature != null) out.temperature = oai.temperature;
  if (oai.top_p != null) out.top_p = oai.top_p;
  out.stream = !!oai.stream;
  return out;
}

// Responses 响应 → OpenAI Chat 响应
function responsesToOpenAIResponse(j) {
  const text = [], toolCalls = [];
  for (const item of j.output ?? []) {
    if (item.type === "message") for (const c of item.content ?? []) if (c.type === "output_text") text.push(c.text);
    if (item.type === "function_call") toolCalls.push({ id: item.id || "fc", type: "function", function: { name: item.name, arguments: item.arguments || "{}" } });
  }
  return {
    id: j.id || "resp", object: "chat.completion", model: j.model,
    choices: [{ index: 0, message: { role: "assistant", content: text.join("") || "", ...(toolCalls.length ? { tool_calls: toolCalls } : {}) }, finish_reason: "stop" }],
    usage: { prompt_tokens: j.usage?.input_tokens ?? 0, completion_tokens: j.usage?.output_tokens ?? 0 },
  };
}

// Responses SSE → OpenAI chunk 流
async function* responsesSSEToChunks(up) {
  const reader = up.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (!data || data === "[DONE]") continue;
        let ev; try { ev = JSON.parse(data); } catch { continue; }
        const base = { id: ev.response?.id || ev.item_id || "resp", object: "chat.completion.chunk", model: ev.response?.model };
        if (ev.type === "response.output_text.delta") {
          yield { chunk: { ...base, choices: [{ index: 0, delta: { content: ev.delta }, finish_reason: null }] } };
        } else if (ev.type === "response.function_call_arguments.delta") {
          yield { chunk: { ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: ev.delta } }] }, finish_reason: null }] } };
        } else if (ev.type === "response.completed") {
          const j = ev.response || {};
          yield { chunk: { ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], ...(j.usage ? { usage: { prompt_tokens: j.usage.input_tokens ?? 0, completion_tokens: j.usage.output_tokens ?? 0 } } : {}) } };
          yield { done: true };
          return;
        } else if (ev.type === "response.failed" || ev.type === "error") {
          throw new UpstreamError(502, "upstream_error", ev.response?.error?.message || ev.error?.message || "responses 流失败", null);
        }
      }
    }
  } finally {
    try { clearTimeout(up.__keylessTimer); } catch {}
  }
}

// 统一的流式归一化出口：无论上游说什么协议，产出 OpenAI chunk 流
function normalizeUpstreamSSE(up, api) {
  if (api === "anthropic-messages") return anthropicSSEToChunks(up);
  if (api === "openai-responses") return responsesSSEToChunks(up);
  return parseUpstreamSSE(up);
}

// 同来源并发闸：acquire 返回 release 函数；排队过长返回 null（调用方放弃该来源换模型）
// 闸只覆盖「发起请求 → 收到响应头」这一段——限流计数发生在请求时刻，
// 响应体读取不占闸，流式长响应不会被卡住。
const providerGates = new Map(); // pid -> {active, waiters:[]}
function gateAcquire(pid) {
  const g = providerGates.get(pid) || { active: 0, waiters: [] };
  providerGates.set(pid, g);
  const release = () => { g.active--; const w = g.waiters.shift(); if (w) { g.active++; w(); } };
  if (g.active < CFG.providerConcurrency) { g.active++; return release; }
  if (g.waiters.length >= 8) return null;
  return new Promise((resolve) => g.waiters.push(() => { g.active++; resolve(release); }));
}

async function callUpstream(key, body, stream, timeoutMs = 0) {
  const e = registry.get(key);
  const p = e && providerOf(key);
  if (!p) throw new UpstreamError(503, "no_provider", `未知来源: ${key}`, key);

  // 超时控制：免费来源偶尔会「连上但不响应」，没有超时会让整个请求卡死。
  // auto 模式用较短的超时（快速失败换模型），普通模式留足生成时间。
  const ms = timeoutMs || (stream ? CFG.timeoutStream : CFG.timeout);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);

  // 按来源协议转换请求体与路径（pivot = OpenAI Chat）
  const api = p.api || "openai-completions";
  let url = `${p.base}/chat/completions`;
  let payload = { ...body, model: e.model, stream };
  if (api === "anthropic-messages") {
    url = `${p.base}/messages`;
    payload = { ...openAIToAnthropic(body, e.model), stream };
  } else if (api === "openai-responses") {
    url = `${p.base}/responses`;
    payload = { ...openAIToResponses(body, e.model), stream };
  }

  let release = gateAcquire(p.id);
  if (!release) {
    throw new UpstreamError(429, "provider_busy", `来源并发已达上限(${CFG.providerConcurrency})且排队满，换模型重试`, key);
  }

  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": CFG.ua },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    });
  } catch (err) {
    release();
    clearTimeout(timer);
    const timedOut = err.name === "AbortError";
    throw new UpstreamError(timedOut ? 504 : -1, timedOut ? "upstream_timeout" : "network_error",
      timedOut ? `上游超时 (${ms}ms)` : (err.message || "网络错误"), key);
  }
  release(); // 响应头已到，闸释放；后续读体/转换不占并发额度

  if (!res.ok) {
    let type = "upstream_error", message = `${res.status}`;
    try {
      const j = await res.json();
      type = j.error?.type || j.error_type || j.type || type;
      message = j.error?.message || j.message || message;
    } catch {}
    clearTimeout(timer);
    // 尊重上游的 Retry-After（秒数或 HTTP 日期）—— 它比我们的固定冷却更权威
    let retryAfter = 0;
    const ra = res.headers.get("retry-after");
    if (ra) {
      const secs = Number(ra);
      retryAfter = Number.isFinite(secs) && secs > 0 ? secs : 0;
      if (!retryAfter) { const d = Date.parse(ra); if (Number.isFinite(d)) retryAfter = Math.max(0, Math.round((d - Date.now()) / 1000)); }
    }
    const e = new UpstreamError(res.status, type, message, key);
    e.retryAfter = retryAfter;
    throw e;
  }

  // 空响应检测（仅非流式）：有些免费模型会返回 200 但内容为空
  // （实测：推理型模型把 max_tokens 全烧在 reasoning 上，JSON/正文出不来）。
  // 对调用方来说这是「成功但没结果」，比报错更难排查，所以在 auto 模式下
  // 直接判为失败并换下一个模型。流式场景响应头已发出，无法再换，只能放过。
  if (!stream) {
    let text = "";
    try {
      text = await res.text();
    } catch (err) {
      clearTimeout(timer);
      const timedOut = err.name === "AbortError";
      throw new UpstreamError(timedOut ? 504 : 502,
        timedOut ? "upstream_timeout" : "read_error",
        timedOut ? `读取上游响应超时 (${ms}ms)` : (err.message || "读取失败"), key);
    }
    clearTimeout(timer);
    let j = null;
    try { j = JSON.parse(text); } catch {}
    if (j) {
      // 非流式响应统一转回 OpenAI pivot，再做空响应检测与包装
      if (api === "anthropic-messages" && j.type === "message") j = anthropicToOpenAIResponse(j);
      else if (api === "openai-responses" && Array.isArray(j.output)) j = responsesToOpenAIResponse(j);
      text = JSON.stringify(j);
      const ch = j.choices?.[0];
      const content = ch?.message?.content ?? ch?.text ?? ch?.delta?.content;
      const empty = content === null || content === undefined || content === "";
      if (empty && ch?.finish_reason === "length") {
        // 截断且无内容 —— 几乎可以肯定是 reasoning 吃光了预算
        throw new UpstreamError(200, "empty_response", "上游返回空内容（可能 max_tokens 被 reasoning 耗尽）", key);
      }
      // 重新包装成可被调用方正常解析的 Response
      const r2 = new Response(text, { status: res.status, headers: res.headers });
      return r2;
    }
    // 不是 JSON 的响应：包一层 error，让下游统一走错误分支
    throw new UpstreamError(502, "bad_response", "上游返回非 JSON 响应", key);
  }
  // 流式：timer 交给调用方在流结束时清理，这里不 clear
  res.__keylessTimer = timer;
  return res;
}

// 带轮换/转移的调用：返回 {res, model: key, failover}
//
// 两种模式：
//   普通模式（指定了具体模型）：最多试 CFG.maxAttempts 次，
//     优先同来源轮换，再跨来源；非限流类错误（4xx 且非 429/403）不转移。
//   auto 模式（model="auto"）：网关自己选模型，最多试 CFG.autoAttempts 次，
//     每次失败（限流/封禁/上游错误/空响应）都换一个模型重试，
//     直到成功或所有候选都试过。这是「保证可用」的关键路径。
async function callWithRotation(requested, body, stream) {
  const auto = isAutoName(requested);
  const maxTry = auto ? CFG.autoAttempts : CFG.maxAttempts;
  let attempt = 0, lastErr = null;
  const tried = [];

  while (attempt < maxTry) {
    let key, failover;

    if (auto) {
      // auto：每次都从「未试过且当前可用」的候选里挑最优的
      key = pickAutoModel(new Set(tried));
      if (!key) {
        // 没有可用候选了：如果还有没试过的（可能处于冷却中），也试一下
        const fallback = freeKeys().find((k) => !tried.includes(k));
        if (!fallback) break;
        key = fallback;
      }
      failover = true;
    } else {
      const pick = attempt === 0 ? pickModel(requested) : pickModel(null);
      if (!pick.key) throw new UpstreamError(503, "no_model", "没有可用的免费模型", null);
      key = pick.key;
      failover = pick.failover;
    }

    if (tried.includes(key)) break;
    tried.push(key);
    ensureState(key).lastUsedAt = Date.now();

    try {
      // auto 模式用更短的单请求超时：宁可快速失败换下一个模型，
      // 也不要卡在一个不响应的上游上把整个请求拖死
      const tmo = auto ? CFG.autoTimeout : 0;
      const res = await callUpstream(key, body, stream, tmo);
      markResult(key, 200);
      if (auto) lastAutoKey = key;      // 记住成功的模型，下次优先复用
      const api = providerOf(key)?.api || "openai-completions";
      return { res, model: key, failover, api };
    } catch (e) {
      lastErr = e;
      if (e.status === 200) markEmpty(key, e.message);   // HTTP 200 但空内容
      else markResult(key, e.status, e.message, e.retryAfter || 0);
      // auto 模式对所有上游故障都换模型重试（这是它存在的意义）
      // 普通模式只对限流类故障转移
      if (!auto) {
        const transient = e.status === 429 || e.status === 403 || e.status >= 500 || e.status === 200;
        if (!transient) break;
      }
      attempt++;
    }
  }
  throw lastErr || new UpstreamError(503, "no_model", "没有可用的免费模型", null);
}

// ── SSE 解析（上游 OpenAI 兼容 chunk 流）──────────────────────────
async function* parseUpstreamSSE(res) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (line.startsWith("data:")) {
          const data = line.slice(5).trim();
          if (data === "[DONE]") { yield { done: true }; return; }
          try { yield { chunk: JSON.parse(data) }; } catch {}
        }
      }
    }
  } finally {
    // 流结束（或异常）后清掉上游超时定时器，否则 Node 进程挂住不退出
    try { clearTimeout(res.__keylessTimer); } catch {}
  }
}

// ── 协议：OpenAI Chat Completions（近直通）────────────────────────
async function handleOpenAI(req, res, body) {
  const stream = body.stream !== false;
  const { res: up, model, failover, api } = await callWithRotation(body.model, {
    messages: body.messages,
    max_tokens: body.max_tokens,
    temperature: body.temperature,
    top_p: body.top_p,
    stop: body.stop,
    tools: body.tools,
    tool_choice: body.tool_choice,
    reasoning_effort: body.reasoning_effort,
  }, stream);
  setModelHeader(res, model, failover);
  if (!stream) {
    const j = await up.json();
    tallyUsage(j.usage);
    // auto 模式下把响应体里的 model 换成实际选中的模型，方便排查
    if (isAutoName(body.model) && j && typeof j === "object") j.model = model;
    return sendJson(res, 200, j);
  }
  sseHeaders(res);
  for await (const ev of normalizeUpstreamSSE(up, api)) {
    if (ev.done) { res.write("data: [DONE]\n\n"); break; }
    if (ev.chunk?.usage) tallyUsage(ev.chunk.usage);
    if (isAutoName(body.model) && ev.chunk && typeof ev.chunk === "object") ev.chunk.model = model;
    res.write(`data: ${JSON.stringify(ev.chunk)}\n\n`);
  }
  res.end();
}

// ── 协议：Anthropic Messages ──────────────────────────────────────
function anthropicToOpenAI(body) {
  const out = { messages: [], max_tokens: body.max_tokens ?? 4096 };
  if (body.system) {
    const sys = Array.isArray(body.system)
      ? body.system.map((b) => b.text || "").join("\n")
      : body.system;
    if (sys) out.messages.push({ role: "system", content: sys });
  }
  if (body.temperature !== undefined) out.temperature = body.temperature;
  if (body.top_p !== undefined) out.top_p = body.top_p;
  if (body.stop_sequences) out.stop = body.stop_sequences;
  for (const m of body.messages || []) {
    if (typeof m.content === "string") { out.messages.push({ role: m.role, content: m.content }); continue; }
    if (m.role === "user") {
      const parts = [], toolResults = [];
      for (const b of m.content || []) {
        if (b.type === "text") parts.push({ type: "text", text: b.text });
        else if (b.type === "image" && b.source) {
          const url = b.source.type === "base64"
            ? `data:${b.source.media_type};base64,${b.source.data}`
            : b.source.url;
          parts.push({ type: "image_url", image_url: { url } });
        } else if (b.type === "tool_result") {
          toolResults.push({ role: "tool", tool_call_id: b.tool_use_id, content: typeof b.content === "string" ? b.content : JSON.stringify(b.content ?? "") });
        }
      }
      // 官方规则：tool 结果先于用户内容
      out.messages.push(...toolResults);
      if (parts.length) out.messages.push({ role: "user", content: parts.length === 1 && parts[0].type === "text" ? parts[0].text : parts });
    } else if (m.role === "assistant") {
      const texts = [], toolCalls = [];
      for (const b of m.content || []) {
        if (b.type === "text") texts.push(b.text);
        else if (b.type === "tool_use") toolCalls.push({ id: b.id, type: "function", function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) } });
      }
      const msg = { role: "assistant", content: texts.join("\n") || null };
      if (toolCalls.length) msg.tool_calls = toolCalls;
      out.messages.push(msg);
    }
  }
  if (body.tools?.length) {
    out.tools = body.tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.input_schema } }));
    if (body.tool_choice) {
      const tc = body.tool_choice;
      out.tool_choice = tc.type === "auto" ? "auto" : tc.type === "any" ? "required" : tc.type === "none" ? "none" : tc.type === "tool" ? { type: "function", function: { name: tc.name } } : "auto";
    }
  }
  return out;
}

function anthropicStopReason(finish) {
  if (finish === "length") return "max_tokens";
  if (finish === "tool_calls" || finish === "tool_use") return "tool_use";
  return "end_turn";
}

async function handleAnthropic(req, res, body) {
  const stream = body.stream === true;
  const oai = anthropicToOpenAI(body);
  const { res: up, model, failover, api } = await callWithRotation(body.model, oai, stream);
  setModelHeader(res, model, failover);
  const msgId = "msg_" + rid();
  if (!stream) {
    const j = await up.json();
    tallyUsage(j.usage);
    const m = j.choices?.[0]?.message ?? {};
    const content = [];
    if (m.reasoning_content) content.push({ type: "thinking", thinking: m.reasoning_content });
    if (m.content) content.push({ type: "text", text: m.content });
    for (const tc of m.tool_calls ?? []) {
      content.push({ type: "tool_use", id: tc.id, name: tc.function?.name, input: safeJson(tc.function?.arguments) });
    }
    if (!content.length) content.push({ type: "text", text: "" });
    return sendJson(res, 200, {
      id: msgId, type: "message", role: "assistant", model,
      content, stop_reason: anthropicStopReason(j.choices?.[0]?.finish_reason), stop_sequence: null,
      usage: { input_tokens: j.usage?.prompt_tokens ?? 0, output_tokens: j.usage?.completion_tokens ?? 0 },
    });
  }
  sseHeaders(res);
  let blockIdx = -1, openBlock = null; // {kind:'text'|'thinking'|'tool', index}
  const toolBuf = new Map();           // oai index -> {id, name, args, blockIdx}
  let finishReason = null, usage = null;
  const startBlock = (cb) => { blockIdx++; openBlock = { kind: cb.type, index: blockIdx }; res.write(`event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: blockIdx, content_block: cb })}\n\n`); };
  const stopBlock = () => { if (openBlock) { res.write(`event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: openBlock.index })}\n\n`); openBlock = null; } };
  res.write(`event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id: msgId, type: "message", role: "assistant", model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } } })}\n\n`);
  for await (const ev of normalizeUpstreamSSE(up, api)) {
    if (ev.done) break;
    const c = ev.chunk?.choices?.[0];
    if (ev.chunk?.usage) { usage = ev.chunk.usage; }
    if (!c) continue;
    const d = c.delta ?? {};
    if (c.finish_reason) finishReason = c.finish_reason;
    if (d.reasoning_content || d.reasoning) {
      const t = d.reasoning_content || d.reasoning;
      if (!openBlock || openBlock.kind !== "thinking") { stopBlock(); startBlock({ type: "thinking", thinking: "" }); }
      res.write(`event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: openBlock.index, delta: { type: "thinking_delta", thinking: t } })}\n\n`);
    }
    if (d.content) {
      if (!openBlock || openBlock.kind !== "text") { stopBlock(); startBlock({ type: "text", text: "" }); }
      res.write(`event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: openBlock.index, delta: { type: "text_delta", text: d.content } })}\n\n`);
    }
    for (const tc of d.tool_calls ?? []) {
      const key = tc.index ?? 0;
      if (!toolBuf.has(key)) {
        stopBlock();
        const id = tc.id || "toolu_" + rid();
        const name = tc.function?.name || "";
        toolBuf.set(key, { id, name, blockIdx: ++blockIdx });
        res.write(`event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: blockIdx, content_block: { type: "tool_use", id, name, input: {} } })}\n\n`);
        openBlock = { kind: "tool", index: blockIdx };
      }
      const tb = toolBuf.get(key);
      if (tc.function?.arguments) {
        res.write(`event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: tb.blockIdx, delta: { type: "input_json_delta", partial_json: tc.function.arguments } })}\n\n`);
      }
    }
  }
  stopBlock();
  res.write(`event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: anthropicStopReason(finishReason), stop_sequence: null }, usage: { output_tokens: usage?.completion_tokens ?? 0 } })}\n\n`);
  res.write(`event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`);
  res.end();
}

// ── 协议：OpenAI Responses ────────────────────────────────────────
function responsesToOpenAI(body) {
  const out = { messages: [] };
  if (body.instructions) out.messages.push({ role: "system", content: body.instructions });
  const input = body.input;
  const items = typeof input === "string" ? [{ role: "user", content: input }] : (input ?? []);
  for (const it of items) {
    if (it.role === "system" || it.role === "developer") out.messages.push({ role: "system", content: textOf(it.content) });
    else if (it.role === "user") out.messages.push({ role: "user", content: textOf(it.content) });
    else if (it.role === "assistant") out.messages.push({ role: "assistant", content: textOf(it.content) });
    else if (it.type === "function_call") out.messages.push({ role: "assistant", tool_calls: [{ id: it.call_id, type: "function", function: { name: it.name, arguments: it.arguments } }] });
    else if (it.type === "function_call_output") out.messages.push({ role: "tool", tool_call_id: it.call_id, content: typeof it.output === "string" ? it.output : JSON.stringify(it.output ?? "") });
  }
  if (body.max_output_tokens) out.max_tokens = body.max_output_tokens;
  if (body.temperature !== undefined) out.temperature = body.temperature;
  if (body.tools?.length) {
    out.tools = body.tools.filter((t) => t.type === "function").map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } }));
  }
  return out;
}
function textOf(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((b) => b.text ?? "").join("");
  return "";
}

async function handleResponses(req, res, body) {
  const stream = body.stream === true;
  const oai = responsesToOpenAI(body);
  const { res: up, model, failover, api } = await callWithRotation(body.model, oai, stream);
  setModelHeader(res, model, failover);
  const respId = "resp_" + rid();
  const itemId = "msg_" + rid();
  if (!stream) {
    const j = await up.json();
    tallyUsage(j.usage);
    const m = j.choices?.[0]?.message ?? {};
    const out = [];
    if (m.content) out.push({ type: "message", id: itemId, status: "completed", role: "assistant", content: [{ type: "output_text", text: m.content, annotations: [] }] });
    for (const tc of m.tool_calls ?? []) out.push({ type: "function_call", id: "fc_" + rid(), call_id: tc.id, name: tc.function?.name, arguments: tc.function?.arguments ?? "", status: "completed" });
    return sendJson(res, 200, {
      id: respId, object: "response", created_at: Math.floor(Date.now() / 1000), status: "completed", model,
      output: out,
      usage: { input_tokens: j.usage?.prompt_tokens ?? 0, output_tokens: j.usage?.completion_tokens ?? 0, total_tokens: (j.usage?.prompt_tokens ?? 0) + (j.usage?.completion_tokens ?? 0) },
    });
  }
  sseHeaders(res);
  const send = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
  send("response.created", { type: "response.created", response: { id: respId, object: "response", status: "in_progress", model } });
  send("response.output_item.added", { type: "response.output_item.added", output_index: 0, item: { type: "message", id: itemId, role: "assistant", content: [] } });
  send("response.content_part.added", { type: "response.content_part.added", item_id: itemId, output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } });
  let full = "", finishReason = null, usage = null;
  const toolCalls = [];
  for await (const ev of normalizeUpstreamSSE(up, api)) {
    if (ev.done) break;
    const c = ev.chunk?.choices?.[0];
    if (ev.chunk?.usage) usage = ev.chunk.usage;
    if (!c) continue;
    const d = c.delta ?? {};
    if (c.finish_reason) finishReason = c.finish_reason;
    if (d.content) {
      full += d.content;
      send("response.output_text.delta", { type: "response.output_text.delta", item_id: itemId, output_index: 0, content_index: 0, delta: d.content });
    }
    for (const tc of d.tool_calls ?? []) {
      const key = tc.index ?? 0;
      if (!toolCalls[key]) {
        toolCalls[key] = { id: "fc_" + rid(), call_id: tc.id, name: tc.function?.name ?? "", arguments: "" };
        send("response.output_item.added", { type: "response.output_item.added", output_index: toolCalls.length, item: { type: "function_call", ...toolCalls[key] } });
      }
      if (tc.function?.arguments) {
        toolCalls[key].arguments += tc.function.arguments;
        send("response.function_call_arguments.delta", { type: "response.function_call_arguments.delta", item_id: toolCalls[key].id, output_index: toolCalls.length, delta: tc.function.arguments });
      }
    }
  }
  send("response.output_text.done", { type: "response.output_text.done", item_id: itemId, output_index: 0, content_index: 0, text: full });
  send("response.content_part.done", { type: "response.content_part.done", item_id: itemId, output_index: 0, content_index: 0, part: { type: "output_text", text: full, annotations: [] } });
  const outItems = [{ type: "message", id: itemId, status: "completed", role: "assistant", content: [{ type: "output_text", text: full, annotations: [] }] }];
  for (const fc of toolCalls.filter(Boolean)) outItems.push({ type: "function_call", ...fc, status: "completed" });
  send("response.output_item.done", { type: "response.output_item.done", output_index: 0, item: outItems[0] });
  send("response.completed", {
    type: "response.completed",
    response: {
      id: respId, object: "response", status: "completed", model, output: outItems,
      usage: { input_tokens: usage?.prompt_tokens ?? 0, output_tokens: usage?.completion_tokens ?? 0, total_tokens: (usage?.prompt_tokens ?? 0) + (usage?.completion_tokens ?? 0) },
    },
  });
  res.write("data: [DONE]\n\n");
  res.end();
}

// ── HTTP 框架 ─────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "local"}`);
  try {
    // Web 控制台：静态单文件 + 本地 vendor 资源，本机自用，不占 API 路径
    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/ui")) {
      const html = fs.readFileSync(path.join(__dirname, "web", "index.html"));
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      return res.end(html);
    }
    // 前端动效库（GSAP）随仓库分发，离线可用；只放行 vendor 目录下的 js/css/woff2
    if (req.method === "GET" && /^\/vendor\/[\w.-]+\.(js|css|woff2)$/.test(url.pathname)) {
      const file = path.join(__dirname, "web", "vendor", path.basename(url.pathname));
      try {
        const buf = fs.readFileSync(file);
        const type = file.endsWith(".js") ? "application/javascript; charset=utf-8"
          : file.endsWith(".css") ? "text/css; charset=utf-8" : "font/woff2";
        res.writeHead(200, { "Content-Type": type, "Cache-Control": "public, max-age=604800" });
        return res.end(buf);
      } catch { /* 找不到就当普通 404 处理 */ }
    }
    if (req.method === "GET" && url.pathname === "/health") {
      return sendJson(res, 200, { status: "ok", version: VERSION, uptime: Math.floor((Date.now() - stats.startedAt) / 1000) });
    }
    if (req.method === "GET" && url.pathname === "/v1/status") return sendJson(res, 200, statusPayload());
    if (req.method === "POST" && url.pathname === "/v1/probe") {
      // 手动探测：会消耗每个模型 1 次请求额度，所以默认关闭、只在用户
      // 明确要求时执行。limit 用于限制本轮最多探几个，避免一次烧光配额。
      const force = url.searchParams.get("force") === "1";
      const limit = int(url.searchParams.get("limit"), 0);
      probeAll(force, limit).catch(() => {});
      return sendJson(res, 202, { accepted: true, force, limit });
    }

    if (!authorize(req, url)) return sendJson(res, 401, { error: { message: "invalid api key", type: "authentication_error" } });

    if (req.method === "GET" && url.pathname === "/v1/models") {
      await refreshModels();
      const data = freeEntries().map(([key, e]) => ({
        id: key, object: "model", created: 0,
        owned_by: e.pid, provider: e.pid, free: true,
      }));
      // auto 伪模型排在最前：它是「保证可用」的推荐入口
      const autoModels = CFG.autoNames.map((n) => ({
        id: n, object: "model", created: 0, owned_by: "keyless-llm",
        provider: "auto", free: true, virtual: true,
        description: "自动选择当前最优可用模型，失败自动换模型重试",
      }));
      return sendJson(res, 200, { object: "list", data: [...autoModels, ...data] });
    }
    if (req.method === "POST" && ["/v1/chat/completions", "/v1/messages", "/v1/responses"].includes(url.pathname)) {
      const body = await readJson(req);
      stats.requests++;
      const t0 = Date.now();
      try {
        if (url.pathname === "/v1/chat/completions") await handleOpenAI(req, res, body);
        else if (url.pathname === "/v1/messages") await handleAnthropic(req, res, body);
        else await handleResponses(req, res, body);
        logReq(body.model, res.getHeader("x-keyless-model"), 200, Date.now() - t0);
      } catch (e) {
        if (e instanceof UpstreamError) {
          markResult(e.model, e.status, e.message);
          const status = e.status >= 400 && e.status < 600 ? e.status : 502;
          if (url.pathname === "/v1/messages") {
            return sendJson(res, status, { type: "error", error: { type: e.type, message: e.message } });
          }
          return sendJson(res, status, { error: { message: e.message, type: e.type, code: e.type } });
        }
        throw e;
      }
      return;
    }
    sendJson(res, 404, { error: { message: `not found: ${url.pathname}`, type: "invalid_request_error" } });
  } catch (e) {
    log("error", `handler: ${e.stack?.split("\n")[0]}`);
    if (!res.headersSent) sendJson(res, 500, { error: { message: e.message, type: "internal_error" } });
    else res.end();
  }
});

function statusPayload() {
  const all = freeEntries();
  const models = [];
  const provs = providers.map((p) => {
    const mine = all.filter(([, e]) => e.pid === p.id).map(([key, e]) => {
      const st = ensureState(key);
      const row = {
        id: key, model: e.model, provider: p.id,
        name: e.name || e.model, ctx: e.context, out: e.output,
        tools: e.tools, auto: autoEligible(key),
        state: st.state, stateAt: st.stateAt, cooldownUntil: st.cooldownUntil,
        lastError: st.lastError, tps: st.tps, ttft: st.ttft, lastUsedAt: st.lastUsedAt,
      };
      models.push(row);
      return row;
    });
    const c = (s) => mine.filter((m) => m.state === s).length;
    return {
      id: p.id, label: p.label, base: p.base, rate: p.rate || "", enabled: !!p.enabled,
      summary: { healthy: c("healthy"), limited: c("limited"), blocked: c("blocked"), unknown: c("unknown"), total: mine.length },
      models: mine,
    };
  });
  const cnt = (s) => models.filter((m) => m.state === s).length;
  return {
    version: VERSION, ua: CFG.ua,
    uptime: Math.floor((Date.now() - stats.startedAt) / 1000),
    providers: provs,
    summary: { healthy: cnt("healthy"), limited: cnt("limited"), blocked: cnt("blocked"), unknown: cnt("unknown"), total: models.length },
    models, stats,
    lastProbeAt, nextProbeAt: lastProbeAt ? lastProbeAt + CFG.probeSeconds * 1000 : 0,
    probeSeconds: CFG.probeSeconds, probing,
    // 探测策略：默认被动学习（0=不主动探测，状态由真实请求得出）
    probeMode: CFG.probeSeconds > 0 ? "interval" : (CFG.probeOnStart ? "startup" : "passive"),
  };
}

function authorize(req, url) {
  if (!CFG.serverKey) return true;
  const auth = req.headers.authorization || "";
  const key = auth.startsWith("Bearer ") ? auth.slice(7) : req.headers["x-api-key"] || "";
  return key === CFG.serverKey;
}
function setModelHeader(res, model, failover) {
  res.setHeader("x-keyless-model", model || "");
  if (failover) { res.setHeader("x-keyless-failover", "1"); stats.failovers++; }
}
function sseHeaders(res) {
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
}
function sendJson(res, code, obj) {
  const s = JSON.stringify(obj);
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(s);
}
async function readJson(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString("utf8");
  try { return JSON.parse(raw || "{}"); } catch { return {}; }
}
function tallyUsage(u) {
  if (!u) return;
  stats.tokensIn += u.prompt_tokens || 0;
  stats.tokensOut += u.completion_tokens || 0;
}
function safeJson(s) { try { return JSON.parse(s); } catch { return {}; } }
function rid() { return Math.random().toString(36).slice(2, 10) + Date.now().toString(36); }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// ── 日志 ──────────────────────────────────────────────────────────
let logStream = null;
function log(level, msg) {
  const line = JSON.stringify({ ts: new Date().toISOString(), level, msg });
  console.log(line);
  try {
    if (!logStream) {
      fs.mkdirSync(CFG.logDir, { recursive: true });
      logStream = fs.createWriteStream(path.join(CFG.logDir, "proxy.log"), { flags: "a" });
    }
    logStream.write(line + "\n");
  } catch {}
}
function logReq(requested, used, status, ms) {
  const line = JSON.stringify({ ts: new Date().toISOString(), requested, used, status, ms });
  try {
    if (!logStream) {
      fs.mkdirSync(CFG.logDir, { recursive: true });
      logStream = fs.createWriteStream(path.join(CFG.logDir, "requests.log"), { flags: "a" });
    }
    logStream.write(line + "\n");
  } catch {}
}

// ── 启动 ──────────────────────────────────────────────────────────
loadProviders();
const PID_FILE = path.join(CFG.logDir, "proxy.pid");
try {
  fs.mkdirSync(CFG.logDir, { recursive: true });
  fs.writeFileSync(PID_FILE, String(process.pid));
  process.on("exit", () => { try { fs.unlinkSync(PID_FILE); } catch {} });
} catch {}
server.listen(CFG.port, CFG.host, () => {
  log("info", `free-llm-gateway v${VERSION} listening http://${CFG.host}:${CFG.port} providers=${providers.filter((p) => p.enabled).length} models=${freeKeys().length}`);
  refreshModels(true).then(() => {
    if (CFG.probeSeconds > 0) setInterval(() => probeAll(false).catch(() => {}), CFG.probeSeconds * 1000);
    if (CFG.probeOnStart) probeAll(false).catch(() => {});
  });
});

// ── 父进程看门狗（launch.ps1 专用）───────────────────────────────
// 启动器把自己的 PID 放进 KEYLESS_PARENT_PID。宿主窗口关闭/Ctrl+C/
// 被强杀时，附着在同一控制台的网关通常会被一并终止；但个别终端
// （Windows Terminal 某些路径、宿主被直接 kill）不会传播信号，
// 网关会变成孤儿继续占端口。这里每 5 秒确认宿主还活着，死了就退出，
// 保证「关窗即停」在所有路径下成立。直接 node server.mjs 无此变量，不受影响。
if (process.env.KEYLESS_PARENT_PID) {
  const parentPid = parseInt(process.env.KEYLESS_PARENT_PID, 10);
  if (parentPid > 0) {
    const watchdog = setInterval(() => {
      try {
        process.kill(parentPid, 0);   // 只探测存活，不发信号
      } catch {
        log("info", `父进程 ${parentPid} 已退出，网关随之停止`);
        clearInterval(watchdog);
        process.exit(0);
      }
    }, 5000);
    watchdog.unref();                 // 不阻止进程自然退出
  }
}
