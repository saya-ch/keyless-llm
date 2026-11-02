// OpenCode 免费车道适配：客户端指纹（UA / session / project）、官方工具集、官方系统提示。
//
// 逻辑移植自 Ebony-Vinyl/dsh-our-free-model 的 src/o2a/（opencode2api v1.4.6 的 JS port）。
// 上游闸门（缺一即 403 FreeTierError / 429）：
//   - UA 必须整串 `opencode/latest/<v>/cli`
//   - x-opencode-session 与 x-opencode-session-id 同值，session 必须「铸造」形状
//     （ses_ + 12 位时间反码 + 14 位 base62）
//   - 请求体必须带官方工具集（13 个，逐字定义），且不能带 tool_choice: none
//   - 系统提示必须是官方 CLI 提示（base prompt + env + skills）
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ASSETS = path.join(__dirname, "opencode");

export const CLIENT_UA = "opencode/latest/2.1.1/cli";
export const ANONYMOUS_CREDENTIAL = "public";
export const V2_COMPLETION_LIMIT = 32000;

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const SESSION_TIMESTAMP_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

function base62Fixed(bytes, width) {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  const out = new Array(width);
  for (let i = width - 1; i >= 0; i--) {
    out[i] = BASE62[Number(n % 62n)];
    n /= 62n;
  }
  return out.join("");
}

function descendingTimePart(now, hash) {
  const offset = (((hash[0] << 24) | (hash[1] << 16) | (hash[2] << 8) | hash[3]) >>> 0) % SESSION_TIMESTAMP_WINDOW_MS;
  const midnight = Math.floor(now / 86400000) * 86400000;
  const inverted = ~((BigInt(midnight - offset) << 12n) | 1n) & 0xffffffffffffn;
  return inverted.toString(16).padStart(12, "0");
}

/** 铸造一个上游接受的会话 id：ses_ + 12 位时间反码 + 14 位 base62。 */
export function mintSession(now = Date.now()) {
  const digest = crypto.randomBytes(16);
  return `ses_${descendingTimePart(now, digest)}${base62Fixed(digest.subarray(6, 16), 14)}`;
}

/** 每请求一个 40-hex project id（配额按 project × egress 记账）。 */
export function randomProjectID() {
  return crypto.randomBytes(20).toString("hex");
}

let toolsCache = null;
/** 官方 13 个工具（chat 形状：strict: false）。 */
export function officialTools() {
  if (toolsCache) return toolsCache;
  const raw = JSON.parse(fs.readFileSync(path.join(ASSETS, "opencode_tools.json"), "utf8"));
  toolsCache = Object.entries(raw).map(([name, def]) => ({
    type: "function",
    function: { name, description: def.description, parameters: def.parameters },
    strict: false,
  }));
  return toolsCache;
}

let promptCache = null;
/** 官方 CLI 系统提示。 */
export function officialPrompt() {
  if (promptCache === null) promptCache = fs.readFileSync(path.join(ASSETS, "opencode_prompt_v2.txt"), "utf8");
  return promptCache;
}

/** v2 请求头集合。 */
export function opencodeHeaders(session) {
  return {
    "content-type": "application/json",
    authorization: `Bearer ${ANONYMOUS_CREDENTIAL}`,
    "user-agent": CLIENT_UA,
    "x-opencode-client": "cli",
    "x-session-affinity": session,
    "x-session-id": session,
    "x-opencode-session": session,
    "x-opencode-session-id": session,
    "x-opencode-project": randomProjectID(),
  };
}

/** 把 OpenAI chat body 整形为免费车道要求的形状。 */
export function shapeBody(body) {
  const out = { ...body };
  const system = officialPrompt();
  out.messages = [
    { role: "system", content: system },
    ...(Array.isArray(body.messages) ? body.messages.filter((m) => m.role !== "system") : []),
  ];
  out.tools = officialTools();
  delete out.tool_choice; // v2 闸门：tool_choice: none 即 403
  if (out.max_completion_tokens === undefined && out.max_tokens === undefined) {
    out.max_completion_tokens = V2_COMPLETION_LIMIT;
  }
  return out;
}
