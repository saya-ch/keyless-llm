// 验证 OpenCode 免费车道（指纹移植自 dsh-our-free-model）是否可用。
// 用法: node scripts/test-opencode.mjs [model]
import { mintSession, opencodeHeaders, shapeBody } from "../lib/opencode.mjs";

const model = process.argv[2] || "deepseek-v4.1-flash-free";
const session = mintSession();
const body = shapeBody({
  model,
  messages: [{ role: "user", content: "Say hi in one word." }],
  stream: false,
});
const r = await fetch("https://opencode.ai/inference/openai/v1/chat/completions", {
  method: "POST",
  headers: opencodeHeaders(session),
  body: JSON.stringify(body),
  signal: AbortSignal.timeout(60000),
});
console.log("model:", model, "session:", session);
console.log("status:", r.status);
const text = await r.text();
console.log(text.slice(0, 800));
if (!r.ok) {
  console.error("::error::OpenCode 免费车道返回非 200:", r.status);
  process.exit(1);
}
