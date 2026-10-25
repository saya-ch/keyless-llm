#!/usr/bin/env node
/**
 * measure-speed.mjs — 通过本地代理实测各模型流式 TPS
 * 用法: node measure-speed.mjs --port 8788 --models a,b,c [--key sk-xxx]
 *
 * 输出 JSON：每个模型都必有一个结果，成功或失败都算结果
 *   成功: { ok:true,  tps, ttft, total, tokens }
 *   失败: { ok:false, status, error, detail, resetAt?, total }
 *         status=0 表示网络层错误（error 为 message）
 */
import http from "node:http";

const args = process.argv.slice(2);
function arg(name, dflt) {
  const i = args.indexOf("--" + name);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
}
const PORT = parseInt(arg("port", "8788"), 10);
const KEY = arg("key", process.env.KEYLESS_KEY || process.env.OC2FREE_KEY || "sk-keyless-local");
const MODELS = arg("models", "").split(",").map((s) => s.trim()).filter(Boolean);
const TIMEOUT = parseInt(arg("timeout", "30000"), 10);

/** 从错误响应体里提取可读原因（OpenAI 风格或 OpenCode 风格） */
function describe(status, body, total) {
  let type = "";
  let msg = "";
  try {
    const j = JSON.parse(body);
    const e = j.error && typeof j.error === "object" ? j.error : (j.error ? { message: String(j.error) } : j);
    type = e.type || e.code || e.errtype || j.type || "";
    msg = e.message || e.msg || j.message || "";
    if (type === "error" && e.error) type = e.error; // 有些实现把 type 写成 "error"
  } catch {
    msg = String(body || "").replace(/\s+/g, " ").trim().slice(0, 200);
  }
  // 429 常见文案里带重置时间，抽出来单独给面板用
  const resetAt =
    /\breset[s]?\b[^0-9]{0,12}([0-9]{4}-[0-9]{2}-[0-9]{2}[ T][0-9]{2}:[0-9]{2}(?::[0-9]{2})?)/i.exec(msg)?.[1] ||
    /\breset[s]?\b[^0-9]{0,12}([0-9]{4}-[0-9]{2}-[0-9]{2})/i.exec(msg)?.[1] ||
    "";
  return {
    ok: false,
    status,
    error: type || (status ? `http ${status}` : "error"),
    detail: msg.slice(0, 160),
    ...(resetAt ? { resetAt } : {}),
    total,
  };
}

function measure(model) {
  return new Promise((resolve) => {
    const body = JSON.stringify({
      model,
      messages: [{ role: "user", content: "从1数到50，只输出数字，用逗号分隔。" }],
      max_tokens: 300,
      stream: true,
    });
    let settled = false;
    const done = (v) => {
      if (!settled) {
        settled = true;
        resolve(v);
      }
    };

    const req = http.request(
      {
        host: "127.0.0.1",
        port: PORT,
        path: "/v1/chat/completions",
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${KEY}` },
      },
      (res) => {
        const t0 = Date.now();
        let ttft = null;
        let tokens = 0;
        let buf = "";
        let raw = "";
        const isOk = res.statusCode === 200;

        res.on("data", (chunk) => {
          const text = chunk.toString();
          if (!isOk) {
            raw += text; // 错误体整段留着解析
            return;
          }
          buf += text;
          let idx;
          while ((idx = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, idx).trim();
            buf = buf.slice(idx + 1);
            if (!line.startsWith("data:")) continue;
            const data = line.slice(5).trim();
            if (data === "[DONE]") continue;
            try {
              const j = JSON.parse(data);
              if (j.error) {
                raw = JSON.stringify(j);
                continue;
              }
              const d = j.choices?.[0]?.delta?.content;
              if (d) {
                if (ttft === null) ttft = Date.now() - t0;
                tokens += d.length; // 近似 token（中文按字计）
              }
            } catch {}
          }
        });

        res.on("end", () => {
          const total = Date.now() - t0;
          if (!isOk) return done(describe(res.statusCode, raw, total));
          if (raw) return done(describe(res.statusCode, raw, total)); // 200 但流里报错
          if (tokens === 0) {
            return done({
              ok: false,
              status: 200,
              error: "empty",
              detail: "上游返回 200 但没有内容（可能被静默限流）",
              total,
            });
          }
          const gen = total - (ttft ?? total);
          done({
            ok: true,
            tps: gen > 0 ? Math.round((tokens / gen) * 1000) : 0,
            ttft,
            total,
            tokens,
          });
        });
        res.on("error", (e) => done({ ok: false, status: 0, error: "stream", detail: e.message, total: Date.now() - t0 }));
      }
    );

    req.setTimeout(TIMEOUT, () => {
      req.destroy();
      done({ ok: false, status: 0, error: "timeout", detail: `${TIMEOUT}ms 内无响应`, total: TIMEOUT });
    });
    req.on("error", (e) => done({ ok: false, status: 0, error: "network", detail: e.message, total: 0 }));
    req.end(body);
  });
}

(async () => {
  const out = {};
  for (const m of MODELS) out[m] = await measure(m);
  console.log(JSON.stringify(out));
})();
