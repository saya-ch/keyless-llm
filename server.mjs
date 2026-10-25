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
  probeSeconds: int(env("PROBE", 1800), 1800),   // 秒；自动轻探测间隔（0=关）
  probeOnStart: int(env("PROBE_ON_START", 1), 1), // 启动时做一次轻探测（每模型 1 token）
  modelsRefresh: int(env("MODELS_TTL", 1800), 1800),
  logDir: env("LOGDIR", path.join(__dirname, "logs")),
  catalogPath: env("CATALOG", path.join(__dirname, "models.catalog.json")),
  providersPath: env("PROVIDERS", path.join(__dirname, "providers.json")),
  maxAttempts: int(env("ATTEMPTS", 2), 2),       // 含首次，最多转移次数
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
let egressScanning = false;             // 出口扫描进行中（避免并发切换 Clash 节点）

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
  for (const p of providers) for (const m of p.staticModels) addModel(p, { id: m });
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
  const ctx = m.context_length || m.context || (m.limit && m.limit.context) || (m.top_provider && m.top_provider.context_length) || null;
  const out = m.max_output || (m.limit && m.limit.output) || (m.top_provider && m.top_provider.max_completion_tokens) || null;
  if (!registry.has(key)) {
    registry.set(key, { pid: p.id, model: mid, free: isFreeModel(p, m), name: mid, context: ctx, output: out });
    ensureState(key);
  } else {
    const e = registry.get(key);
    if (ctx && !e.context) e.context = ctx;
    if (out && !e.output) e.output = out;
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
function markResult(id, status, errMsg) {
  const st = ensureState(id);
  st.stateAt = Date.now();
  if (status === 200) {
    if (st.state !== "healthy") log("info", `model ${id}: -> healthy`);
    st.state = "healthy"; st.cooldownUntil = 0; st.lastError = "";
  } else if (status === 429) {
    if (st.state !== "limited") log("info", `model ${id}: -> limited (429) cd=${CFG.cooldown429}s`);
    st.state = "limited"; st.cooldownUntil = Date.now() + CFG.cooldown429 * 1000; st.lastError = errMsg || "429";
  } else if (status === 403) {
    if (st.state !== "blocked") log("info", `model ${id}: -> blocked (403) cd=${CFG.cooldown403}s`);
    st.state = "blocked"; st.cooldownUntil = Date.now() + CFG.cooldown403 * 1000; st.lastError = errMsg || "403";
  } else if (status >= 500) {
    st.state = "limited"; st.cooldownUntil = Date.now() + 60 * 1000; st.lastError = `${status}`;
  } else if (status !== -1) {
    st.state = "unknown"; st.lastError = `${status} ${errMsg || ""}`.trim();
  }
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

async function probeAll(force = false) {
  if (probing) return;
  probing = true;
  try {
    const keys = freeKeys().filter((k) => {
      if (force) return true;
      if (!available(k)) return false;
      const st = ensureState(k);
      if (st.state === "unknown" && Date.now() - (st.stateAt || 0) < PROBE_SKIP_UNKNOWN_MS) return false;
      return true;
    });
    log("info", `probe ${keys.length} free models${force ? " (force)" : ""}`);
    for (const k of keys) { await probeModel(k); await sleep(500); }
    lastProbeAt = Date.now();
  } finally { probing = false; }
}

// ── 上游调用 ──────────────────────────────────────────────────────
class UpstreamError extends Error {
  constructor(status, type, message, model) { super(message); this.status = status; this.type = type; this.model = model; }
}

async function callUpstream(key, body, stream) {
  const e = registry.get(key);
  const p = e && providerOf(key);
  if (!p) throw new UpstreamError(503, "no_provider", `未知来源: ${key}`, key);
  const res = await fetch(`${p.base}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": CFG.ua },
    body: JSON.stringify({ ...body, model: e.model, stream }),
  });
  if (!res.ok) {
    let type = "upstream_error", message = `${res.status}`;
    try {
      const j = await res.json();
      type = j.error?.type || j.error_type || j.type || type;
      message = j.error?.message || j.message || message;
    } catch {}
    throw new UpstreamError(res.status, type, message, key);
  }
  return res;
}

// 带轮换/转移的调用：返回 {res, model: key, failover}
async function callWithRotation(requested, body, stream) {
  let attempt = 0, lastErr = null;
  const tried = [];
  while (attempt < CFG.maxAttempts) {
    const pick = attempt === 0 ? pickModel(requested) : pickModel(null);
    if (!pick.key) throw new UpstreamError(503, "no_model", "没有可用的免费模型", null);
    if (tried.includes(pick.key)) break;
    tried.push(pick.key);
    ensureState(pick.key).lastUsedAt = Date.now();
    try {
      const res = await callUpstream(pick.key, body, stream);
      markResult(pick.key, 200);
      return { res, model: pick.key, failover: pick.failover };
    } catch (e) {
      lastErr = e;
      markResult(pick.key, e.status, e.message);
      if (e.status !== 429 && e.status !== 403 && e.status < 500) break; // 非限流类错误不转移
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
}

// ── 协议：OpenAI Chat Completions（近直通）────────────────────────
async function handleOpenAI(req, res, body) {
  const stream = body.stream !== false;
  const { res: up, model, failover } = await callWithRotation(body.model, {
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
    return sendJson(res, 200, j);
  }
  sseHeaders(res);
  for await (const ev of parseUpstreamSSE(up)) {
    if (ev.done) { res.write("data: [DONE]\n\n"); break; }
    if (ev.chunk?.usage) tallyUsage(ev.chunk.usage);
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
  const { res: up, model, failover } = await callWithRotation(body.model, oai, stream);
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
  for await (const ev of parseUpstreamSSE(up)) {
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
  const { res: up, model, failover } = await callWithRotation(body.model, oai, stream);
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
  for await (const ev of parseUpstreamSSE(up)) {
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
    if (req.method === "GET" && url.pathname === "/health") {
      return sendJson(res, 200, { status: "ok", version: VERSION, uptime: Math.floor((Date.now() - stats.startedAt) / 1000) });
    }
    if (req.method === "GET" && url.pathname === "/v1/status") return sendJson(res, 200, statusPayload());
    if (req.method === "POST" && url.pathname === "/v1/probe") {
      const force = url.searchParams.get("force") === "1";
      probeAll(force).catch(() => {});
      return sendJson(res, 202, { accepted: true, force });
    }
    // 出口探测结果（多 IP 逐个实测，见 scripts/egress-scan.mjs）
    // 与 /v1/status 同级：供本地面板读取，不做 key 校验
    if (req.method === "GET" && url.pathname === "/v1/egress") {
      let data = { results: [], scannedAt: 0 };
      try {
        data = JSON.parse(fs.readFileSync(path.join(__dirname, "egress.json"), "utf8"));
      } catch {}
      const age = data.scannedAt ? Math.floor((Date.now() - data.scannedAt) / 1000) : -1;
      return sendJson(res, 200, { ...data, age, scanning: egressScanning });
    }
    if (req.method === "POST" && url.pathname === "/v1/egress/scan") {
      if (egressScanning) return sendJson(res, 202, { accepted: false, reason: "scan already running" });
      const models = url.searchParams.get("models") || "3";
      egressScanning = true;
      log("info", "egress scan: start");
      const child = spawn(process.execPath, [path.join(__dirname, "scripts", "egress-scan.mjs"), "--models", models], {
        cwd: __dirname,
        stdio: "ignore",
      });
      child.on("exit", (code) => {
        egressScanning = false;
        log("info", `egress scan: done code=${code}`);
      });
      child.on("error", (e) => {
        egressScanning = false;
        log("error", `egress scan: ${e.message}`);
      });
      return sendJson(res, 202, { accepted: true, models });
    }

    if (!authorize(req, url)) return sendJson(res, 401, { error: { message: "invalid api key", type: "authentication_error" } });

    if (req.method === "GET" && url.pathname === "/v1/models") {
      await refreshModels();
      const data = freeEntries().map(([key, e]) => ({
        id: key, object: "model", created: 0,
        owned_by: e.pid, provider: e.pid, free: true,
      }));
      return sendJson(res, 200, { object: "list", data });
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
