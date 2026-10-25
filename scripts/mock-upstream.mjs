#!/usr/bin/env node
/**
 * mock-upstream.mjs — 本地 mock 的 OpenAI 兼容上游（离线验证用）
 * 规则：模型名含 limited → 429；含 blocked → 403；其它 → 200 正常流式/非流式
 * 环境变量 MOCK_FORCE=429|403 可强制所有请求返回该状态（模拟额度全耗尽）
 */
import http from "node:http";

const FORCE = (process.env.MOCK_FORCE || "").trim();

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  if (req.method === "GET" && url.pathname === "/v1/models") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ object: "list", data: [
      { id: "ok-model", object: "model" }, { id: "limited-model", object: "model" }, { id: "blocked-model", object: "model" },
    ] }));
  }
  if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    const model = body.model || "";
    if (FORCE === "429") {
      res.writeHead(429, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({
        type: "error",
        error: {
          type: "FreeUsageLimitError",
          message: "Free usage limit reached, resets at 2026-10-26 17:51:07 UTC+8",
        },
      }));
    }
    if (FORCE === "403") {
      res.writeHead(403, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ type: "error", error: { type: "forbidden", message: "region not allowed" } }));
    }
    if (model.includes("limited")) {
      res.writeHead(429, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ type: "error", error: { type: "FreeUsageLimitError", message: "Free usage limit reached." } }));
    }
    if (model.includes("blocked")) {
      res.writeHead(403, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ type: "error", error: { type: "forbidden", message: "blocked" } }));
    }
    if (body.stream) {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      const words = ["Hello", " from", " mock", " upstream", "!"];
      for (let i = 0; i < words.length; i++) {
        res.write(`data: ${JSON.stringify({ id: "chatcmpl-1", object: "chat.completion.chunk", choices: [{ index: 0, delta: i === 0 ? { role: "assistant", content: words[i] } : { content: words[i] }, finish_reason: null }] })}\n\n`);
        await new Promise((r) => setTimeout(r, 20));
      }
      res.write(`data: ${JSON.stringify({ id: "chatcmpl-1", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 7, completion_tokens: 5 } })}\n\n`);
      res.write("data: [DONE]\n\n");
      return res.end();
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({
      id: "chatcmpl-1", object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: "Hello from mock upstream!" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 7, completion_tokens: 5 },
    }));
  }
  // ── Anthropic Messages 协议（验证网关的来源协议适配层）──
  if (req.method === "POST" && url.pathname === "/v1/messages") {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    const text = `Hello from mock anthropic upstream! (model=${body.model})`;
    if (!body.stream) {
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({
        id: "msg_mock1", type: "message", role: "assistant", model: body.model,
        content: [
          { type: "thinking", thinking: "user wants a greeting" },
          { type: "text", text },
        ],
        stop_reason: "end_turn",
        usage: { input_tokens: 9, output_tokens: 12 },
      }));
    }
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    const send = (obj) => res.write(`event: ${obj.type}\ndata: ${JSON.stringify(obj)}\n\n`);
    send({ type: "message_start", message: { id: "msg_mock1", type: "message", role: "assistant", model: body.model, content: [], usage: { input_tokens: 9, output_tokens: 0 } } });
    send({ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } });
    send({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "greeting..." } });
    send({ type: "content_block_stop", index: 0 });
    send({ type: "content_block_start", index: 1, content_block: { type: "text", text: "" } });
    for (const w of ["Hello", " from", " mock", " anthropic!"]) {
      send({ type: "content_block_delta", index: 1, delta: { type: "text_delta", text: w } });
      await new Promise((r) => setTimeout(r, 20));
    }
    send({ type: "content_block_stop", index: 1 });
    send({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { input_tokens: 9, output_tokens: 12 } });
    send({ type: "message_stop" });
    return res.end();
  }
  res.writeHead(404); res.end();
});
server.listen(9911, "127.0.0.1", () => console.log("mock upstream on 9911"));
