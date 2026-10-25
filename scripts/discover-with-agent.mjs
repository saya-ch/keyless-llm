#!/usr/bin/env node
/**
 * discover-with-agent.mjs — 用 agent 搜索新的免鉴权大模型服务
 *
 * 这一步是「搜索」，本质是语义判断，所以交给 LLM agent：
 *   - 读搜索结果，判断哪些可能是 OpenAI 兼容的免鉴权端点
 *   - 剔除需要注册/需要 key/已停服的
 *   - 给出候选的 base URL 和一个可测的模型名
 * 产出的候选再交给 validate-source.mjs 做确定性实测。
 *
 * 环境变量：
 *   AGENT_API_KEY   必填，agent 用的 API key
 *   AGENT_BASE_URL  可选，OpenAI 兼容端点，默认 https://api.openai.com/v1
 *   AGENT_MODEL     可选，模型名，默认 gpt-4o-mini
 *   SEARCH_QUERY    可选，自定义搜索词；留空用默认关键词组
 *
 * 输出：candidates.json  { generatedAt, candidates: [{ label, base, testModel, note }] }
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const API_KEY = process.env.AGENT_API_KEY || "";
const BASE_URL = (process.env.AGENT_BASE_URL || "https://api.openai.com/v1").replace(/\/+$/, "");
const MODEL = process.env.AGENT_MODEL || "gpt-4o-mini";

const DEFAULT_QUERIES = [
  "free no-auth OpenAI-compatible API endpoint no API key required 2026",
  "免鉴权 大模型 API 无限免费 OpenAI 兼容 接口",
  "\"no API key\" free LLM inference endpoint openai compatible",
  "openrouter alternative anonymous free tier api no signup",
  "免费大模型 API 无需 key 直接调用 openai chat completions",
];

const SYSTEM_PROMPT = `你是一个严格的技术侦察员，任务是在互联网上找出「真正无需 API key 就能调用」的 OpenAI 兼容大模型端点。

判断标准（必须严格执行）：
1. 无需注册、无需 token、无需 Authorization 头，匿名 POST /chat/completions 能拿到 200 和真实文本
2. 暴露 OpenAI 兼容接口（/chat/completions、/v1/chat/completions、/models 等）
3. 免费额度是真实存在的，不是「首送 1 分钱」这种一次性促销

必须排除：
- 需要 API key 的（哪怕有免费额度也要排除）
- 需要先注册账号换 token 的
- 已停止服务或只有演示页的
- 需要上传文件/审核才能用的

输出要求：只输出 JSON，不要任何解释文字或 markdown 代码块。
格式：
{"candidates":[{"label":"服务名","base":"https://完整base路径","testModel":"一个确定存在且免费的模型名","note":"一句话说明你为什么认为它免鉴权"}]}

base 必须是完整的 API base（例如 https://api.example.com/v1），不能是官网首页。
如果你认为没有合格的新来源，就返回 {"candidates":[]}。宁可少报也不要报错来源。`;

async function chat(messages, { json = false, maxTokens = 2000 } = {}) {
  const res = await fetch(`${BASE_URL}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${API_KEY}` },
    body: JSON.stringify({
      model: MODEL,
      messages,
      max_tokens: maxTokens,
      temperature: 0.2,
      ...(json ? { response_format: { type: "json_object" } } : {}),
    }),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`agent 请求失败 ${res.status}: ${t.slice(0, 300)}`);
  }
  const j = await res.json();
  return j.choices?.[0]?.message?.content ?? "";
}

// 从 agent 输出里抠出 JSON（容忍 ```json 包裹和前后废话）
function extractJson(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1] : text;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(body.slice(start, end + 1)); } catch { return null; }
}

function normalizeCandidates(obj) {
  const list = Array.isArray(obj?.candidates) ? obj.candidates : [];
  const seen = new Set();
  const out = [];
  for (const c of list) {
    const base = String(c.base || "").trim().replace(/\/+$/, "");
    if (!/^https?:\/\//i.test(base)) continue;
    if (seen.has(base)) continue;
    seen.add(base);
    out.push({
      label: String(c.label || new URL(base).host),
      base,
      testModel: c.testModel ? String(c.testModel) : null,
      note: String(c.note || ""),
    });
  }
  return out;
}

async function main() {
  if (!API_KEY) {
    console.log("未配置 AGENT_API_KEY，跳过 agent 搜索");
    return;
  }
  const queries = process.env.SEARCH_QUERY
    ? [process.env.SEARCH_QUERY]
    : DEFAULT_QUERIES;

  const all = [];
  for (const q of queries) {
    console.log(`\n[search] ${q}`);
    try {
      const text = await chat([
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: `搜索关键词：${q}\n\n请基于你的知识与检索结果，给出符合标准的候选来源，输出 JSON。` },
      ], { json: true });
      const obj = extractJson(text);
      const cands = normalizeCandidates(obj);
      console.log(`  → ${cands.length} 个候选`);
      for (const c of cands) console.log(`    ${c.label}  ${c.base}  model=${c.testModel || "?"}`);
      all.push(...cands);
    } catch (e) {
      console.error(`  ! ${e.message}`);
    }
  }

  // 去重
  const seen = new Set();
  const uniq = all.filter((c) => (seen.has(c.base) ? false : (seen.add(c.base), true)));

  const out = {
    generatedAt: new Date().toISOString(),
    queries,
    candidates: uniq,
  };
  const file = path.join(ROOT, "candidates.json");
  fs.writeFileSync(file, JSON.stringify(out, null, 2) + "\n", "utf8");
  console.log(`\n候选清单写入 ${path.relative(ROOT, file)}（${uniq.length} 个）`);
}

main().catch((e) => { console.error(e); process.exit(1); });
