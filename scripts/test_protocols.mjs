#!/usr/bin/env node
/** 全协议离线验证：OpenAI / Anthropic / Responses × 流式/非流式 × 轮换/状态机 */
const BASE = "http://127.0.0.1:8899";
const KEY = "sk-keyless-local";
let pass = 0, fail = 0;

function check(name, cond, detail = "") {
  if (cond) { pass++; console.log(`  PASS ${name}`); }
  else { fail++; console.log(`  FAIL ${name} ${detail}`); }
}

async function api(path, body, headers = {}) {
  const res = await fetch(BASE + path, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${KEY}`, ...headers },
    body: JSON.stringify(body),
  });
  return res;
}

async function readSSE(res) {
  const events = [];
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (line.startsWith("data:")) {
        const d = line.slice(5).trim();
        if (d !== "[DONE]") { try { events.push(JSON.parse(d)); } catch {} }
      }
    }
  }
  return events;
}

(async () => {
  // ── health / status / models ──
  const h = await (await fetch(BASE + "/health")).json();
  check("health", h.status === "ok" && h.version);
  const st = await (await fetch(BASE + "/v1/status")).json();
  check("status has 3 free models", st.summary.total === 3, JSON.stringify(st.summary));
  const ml = await (await fetch(BASE + "/v1/models", { headers: { Authorization: `Bearer ${KEY}` } })).json();
  check("models list", Array.isArray(ml.data) && ml.data.length >= 3);

  // ── OpenAI 非流式 ──
  let r = await api("/v1/chat/completions", { model: "ok-model", messages: [{ role: "user", content: "hi" }], stream: false });
  let j = await r.json();
  check("openai non-stream 200", r.status === 200 && j.choices?.[0]?.message?.content?.includes("mock"), JSON.stringify(j).slice(0, 200));

  // ── OpenAI 流式 ──
  r = await api("/v1/chat/completions", { model: "ok-model", messages: [{ role: "user", content: "hi" }], stream: true });
  const chunks = await readSSE(r);
  const text = chunks.map((c) => c.choices?.[0]?.delta?.content || "").join("");
  check("openai stream", r.status === 200 && text.includes("Hello") && chunks.some((c) => c.usage), text);

  // ── Anthropic 非流式 ──
  r = await api("/v1/messages", { model: "ok-model", max_tokens: 100, messages: [{ role: "user", content: "hi" }], stream: false });
  j = await r.json();
  check("anthropic non-stream", r.status === 200 && j.type === "message" && j.content?.[0]?.type === "text" && j.content[0].text.includes("mock") && j.usage?.input_tokens === 7, JSON.stringify(j).slice(0, 300));

  // ── Anthropic 流式 ──
  r = await api("/v1/messages", { model: "ok-model", max_tokens: 100, messages: [{ role: "user", content: "hi" }], stream: true });
  const evs = [];
  {
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let buf = "", cur = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (line.startsWith("event:")) cur = line.slice(6).trim();
        else if (line.startsWith("data:")) evs.push({ event: cur, data: (() => { try { return JSON.parse(line.slice(5).trim()); } catch { return null; } })() });
      }
    }
  }
  const types = evs.map((e) => e.event);
  check("anthropic stream events", types.includes("message_start") && types.includes("content_block_delta") && types.includes("message_delta") && types.includes("message_stop"), types.join(","));
  const md = evs.find((e) => e.event === "message_delta");
  check("anthropic stop_reason", md?.data?.delta?.stop_reason === "end_turn");

  // ── Anthropic system + tools 转换 ──
  r = await api("/v1/messages", {
    model: "ok-model", max_tokens: 100, stream: false,
    system: "You are helpful.",
    tools: [{ name: "get_weather", description: "w", input_schema: { type: "object", properties: { city: { type: "string" } } } }],
    messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
  });
  check("anthropic tools request", r.status === 200);

  // ── Responses 非流式 ──
  r = await api("/v1/responses", { model: "ok-model", input: "hi", instructions: "be brief", stream: false, max_output_tokens: 50 });
  j = await r.json();
  check("responses non-stream", r.status === 200 && j.object === "response" && j.output?.[0]?.content?.[0]?.text?.includes("mock") && j.usage?.total_tokens === 12, JSON.stringify(j).slice(0, 300));

  // ── Responses 流式 ──
  r = await api("/v1/responses", { model: "ok-model", input: "hi", stream: true });
  const revs = await readSSE(r);
  const rtypes = revs.map((e) => e.type);
  check("responses stream events", rtypes.includes("response.created") && rtypes.includes("response.output_text.delta") && rtypes.includes("response.completed"), rtypes.join(","));
  const rtext = revs.filter((e) => e.type === "response.output_text.delta").map((e) => e.delta).join("");
  check("responses text", rtext.includes("Hello"), rtext);

  // ── 轮换转移：limited-model 应自动切到 ok-model ──
  r = await api("/v1/chat/completions", { model: "limited-model", messages: [{ role: "user", content: "hi" }], stream: false });
  j = await r.json();
  check("failover on 429", r.status === 200 && r.headers.get("x-keyless-failover") === "1" && r.headers.get("x-keyless-model") !== "limited-model", `hdr=${r.headers.get("x-keyless-model")}`);

  // ── 状态机：limited-model 进入 limited ──
  await new Promise((r2) => setTimeout(r2, 300));
  const st2 = await (await fetch(BASE + "/v1/status")).json();
  const lm = st2.models.find((m) => m.id === "limited-model");
  check("state machine limited", lm?.state === "limited" && lm.cooldownUntil > Date.now(), JSON.stringify(lm));

  // ── blocked-model 直接报错（403 也转移一次；全部冷却时暴露错误）──
  r = await api("/v1/chat/completions", { model: "blocked-model", messages: [{ role: "user", content: "hi" }], stream: false });
  check("blocked failover to ok", r.status === 200 && r.headers.get("x-keyless-model") !== "blocked-model");

  // ── 探测接口 ──
  const pr = await fetch(BASE + "/v1/probe?force=1", { method: "POST", headers: { Authorization: `Bearer ${KEY}` } });
  check("probe accepted", pr.status === 202);

  // ── 鉴权 ──
  r = await fetch(BASE + "/v1/models");
  check("auth required", r.status === 401);

  console.log(`\n===== ${pass} passed, ${fail} failed =====`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("FATAL", e); process.exit(1); });
