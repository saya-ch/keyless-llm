#!/usr/bin/env node
/**
 * discover-with-agent.mjs — 用 agent 搜索新的免鉴权大模型服务
 *
 * 这一步是「搜索」，本质是语义判断，所以交给 LLM：
 *   - 读搜索结果，判断哪些可能是 OpenAI 兼容的免鉴权端点
 *   - 剔除需要注册/需要 key/已停服的
 *   - 给出候选的 base URL 和一个可测的模型名
 * 产出的候选再交给 validate-source.mjs 做确定性实测。
 *
 * ══ 降级链（保证一定能跑完）════════════════════════════════════
 *   LLM 后端：  ① 本地网关 model=auto  →  ② 直连上游来源  →  ③ 纯规则提取（不用 LLM）
 *   搜索后端：  ① DuckDuckGo HTML（免 key） → ② Bing（免 key） → ③ 内置种子列表
 *   输出：      任何一条腿都断，都仍然产出 candidates.json（内容可能少，但不会是空文件）
 *
 * 关键设计：
 *   - agent 只负责提候选，判定权交给 validate-source.mjs 的实测
 *   - 任务用「提取 URL 列表」而非「输出 JSON」——实测证明免费小模型
 *     做 JSON 结构化输出不可靠（3/12），但做 URL 提取很稳
 *   - 每次 LLM 调用都带重试 + 换模型，不指望一次成功
 *
 * 环境变量：
 *   KEYLESS_GATEWAY   网关地址，默认 http://127.0.0.1:8788
 *   KEYLESS_KEY       网关的本地 key，默认 sk-keyless-local
 *   KEYLESS_MODEL     网关里的模型名，默认 auto
 *   AGENT_BASE_URL    直连兜底用（可选），OpenAI 兼容端点
 *   AGENT_API_KEY     直连兜底用的 key（可选）
 *   AGENT_MODEL       直连兜底用的模型名
 *   SEARCH_QUERY      自定义搜索词（可选）
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const GATEWAY = (process.env.KEYLESS_GATEWAY || "http://127.0.0.1:8788").replace(/\/+$/, "");
const GATEWAY_KEY = process.env.KEYLESS_KEY || "sk-keyless-local";
const GATEWAY_MODEL = process.env.KEYLESS_MODEL || "auto";
const DIRECT_BASE = (process.env.AGENT_BASE_URL || "").replace(/\/+$/, "");
const DIRECT_KEY = process.env.AGENT_API_KEY || "";
const DIRECT_MODEL = process.env.AGENT_MODEL || "gpt-4o-mini";

// GitHub Models：GitHub Actions 内置 GITHUB_TOKEN 就能用（需 permissions: models: read）
// 这是 CI 场景最可靠的 LLM 后端 —— 免费来源按 IP 限流，
// GitHub Actions 的共享出口 IP 很可能在网关侧就已经 429 了，
// 而 GitHub Models 走官方通道，不受这个影响，且零配置、无 secret。
const GH_MODELS_BASE = "https://models.github.ai/inference";
const GH_TOKEN = process.env.GITHUB_TOKEN || "";
const GH_MODEL = process.env.GH_MODELS_MODEL || "openai/gpt-4o-mini";

const UA_BROWSER = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

const DEFAULT_QUERIES = [
  "free no-auth OpenAI-compatible API endpoint no API key required",
  "免鉴权 大模型 API 免费 无需 key OpenAI 兼容",
  "\"no API key\" LLM inference endpoint openai compatible free tier",
  "openrouter alternative anonymous free api no signup",
  "免费大模型 API 匿名调用 chat completions 不用注册",
  "public inference API free without key openai format",
];

// 无 LLM 时的兜底：已知候选，仍要过 validate-source.mjs 实测才算数
const SEED_BASES = [
  "https://api.pollinations.ai/openai",
  "https://text.pollinations.ai/openai",
  "https://openrouter.ai/api/v1",
];

const TIMEOUT = 45000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(...a);

// ── 搜索层 ────────────────────────────────────────────────────────
const SEARCH_BACKENDS = [
  {
    name: "duckduckgo",
    async run(q) {
      const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`;
      const r = await fetch(url, { headers: { "User-Agent": UA_BROWSER }, signal: AbortSignal.timeout(20000) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const html = await r.text();
      const out = [];
      const re = /uddg=([^"&]+)/g;
      let m;
      while ((m = re.exec(html))) {
        try { out.push(decodeURIComponent(m[1])); } catch {}
      }
      if (!out.length) throw new Error("解析不到结果链接");
      return [...new Set(out)];
    },
  },
  {
    name: "bing",
    async run(q) {
      const url = `https://www.bing.com/search?q=${encodeURIComponent(q)}`;
      const r = await fetch(url, {
        headers: { "User-Agent": UA_BROWSER, "Accept-Language": "en-US,en;q=0.9" },
        signal: AbortSignal.timeout(20000),
        redirect: "follow",
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const html = await r.text();
      const out = [];
      const re = /<h2><a href="(https?:\/\/[^"]+)"/g;
      let m;
      while ((m = re.exec(html))) out.push(m[1]);
      if (!out.length) {
        const re2 = /href="(https?:\/\/(?!www\.|go\.|microsoft|bing)[^"]{12,})"/g;
        while ((m = re2.exec(html))) out.push(m[1]);
      }
      if (!out.length) throw new Error("解析不到结果链接");
      return [...new Set(out)];
    },
  },
];

async function searchWeb(q) {
  for (const be of SEARCH_BACKENDS) {
    try {
      const r = await be.run(q);
      log(`    [搜索:${be.name}] ${r.length} 条链接`);
      return { backend: be.name, links: r };
    } catch (e) {
      log(`    [搜索:${be.name}] 失败: ${e.message}`);
    }
  }
  return null;
}

// ── LLM 层 ────────────────────────────────────────────────────────
const SYSTEM_PROMPT = `You find free AI API endpoints that work WITHOUT an API key.

A valid candidate must:
- Work with NO Authorization header (anonymous POST /chat/completions returns 200 with real text)
- Expose an OpenAI-compatible API (/chat/completions or /v1/chat/completions)
- Have a genuine free tier (not a one-time promo)

Exclude: anything needing a key, needing registration, shut down, or demo-only.

List every URL or domain in the search results that could be an AI/LLM API provider.
One per line. No numbering, no explanation, no JSON. Include the service name after a
pipe, like: https://api.example.com/v1 | Example API`;

// 从模型输出里提取 URL/域名行
function extractLines(text) {
  if (!text) return [];
  return text.split(/\r?\n/)
    .map((s) => s.trim())
    .map((s) => s.replace(/^[\-\*\d\.\)\s>#]+/, ""))
    .map((s) => s.replace(/^["'`]|["'`,\.]$/g, ""))
    .filter(Boolean)
    .map((s) => {
      const [url, name] = s.split("|").map((x) => x.trim());
      return { url, name: name || "" };
    })
    .filter((x) => /^(https?:\/\/)?[a-z0-9]([a-z0-9\-\.]*\.[a-z]{2,})(\/[^\s]*)?$/i.test(x.url))
    .filter((x) => !/^(example|test|localhost|127\.0\.0\.1|schema|w3\.org|github\.com\/search)/i.test(x.url));
}

// 网关调用（auto 模式自带模型调度与重试）
async function callGateway(prompt) {
  const r = await fetch(`${GATEWAY}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${GATEWAY_KEY}` },
    body: JSON.stringify({
      model: GATEWAY_MODEL,
      max_tokens: 1200,
      stream: false,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: prompt },
      ],
    }),
    signal: AbortSignal.timeout(TIMEOUT),
  });
  if (!r.ok) {
    const t = await r.text().catch(() => "");
    throw new Error(`网关 ${r.status}: ${t.slice(0, 160)}`);
  }
  const j = await r.json();
  const txt = j.choices?.[0]?.message?.content || "";
  if (!txt.trim()) throw new Error(`网关返回空内容 (模型 ${j.model})`);
  return { text: txt, model: j.model };
}

// GitHub Models：CI 里最可靠的一档（零配置，走官方通道不受免费来源限流影响）
async function callGitHubModels(prompt) {
  if (!GH_TOKEN) throw new Error("未设置 GITHUB_TOKEN（workflow 需 permissions: models: read）");
  const r = await fetch(`${GH_MODELS_BASE}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${GH_TOKEN}` },
    body: JSON.stringify({
      model: GH_MODEL, max_tokens: 1500, stream: false,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: prompt },
      ],
    }),
    signal: AbortSignal.timeout(TIMEOUT),
  });
  if (!r.ok) {
    const t = await r.text().catch(() => "");
    throw new Error(`GitHubModels ${r.status}: ${t.slice(0, 160)}`);
  }
  const j = await r.json();
  const txt = j.choices?.[0]?.message?.content || "";
  if (!txt.trim()) throw new Error("GitHubModels 返回空内容");
  return { text: txt, model: GH_MODEL };
}

// 直连兜底
async function callDirect(prompt) {
  if (!DIRECT_BASE || !DIRECT_KEY) throw new Error("未配置 AGENT_BASE_URL / AGENT_API_KEY");
  const r = await fetch(`${DIRECT_BASE}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${DIRECT_KEY}` },
    body: JSON.stringify({
      model: DIRECT_MODEL, max_tokens: 1200, stream: false,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: prompt },
      ],
    }),
    signal: AbortSignal.timeout(TIMEOUT),
  });
  if (!r.ok) throw new Error(`直连 ${r.status}`);
  const j = await r.json();
  const txt = j.choices?.[0]?.message?.content || "";
  if (!txt.trim()) throw new Error("直连返回空内容");
  return { text: txt, model: DIRECT_MODEL };
}

// 纯规则兜底：不用 LLM，从链接里按特征挑候选
function ruleExtract(links) {
  const hints = /(openai|anthropic|llm|infer|ai-|api|gpt|chat|completion|model|ollama|groq|huggingface|pollinations|openrouter|cerebras|deepinfra|together|nous|fireworks|sambanova|replicate|ai21|writer|anyscale|mistral|nvidia)/i;
  const out = [];
  for (const raw of links) {
    let u;
    try { u = new URL(raw); } catch { continue; }
    if (!/^https?:$/.test(u.protocol)) continue;
    const host = u.hostname;
    if (/^(www\.|docs\.|github|gitlab|stackoverflow|medium|reddit|twitter|x\.com|linkedin|wikipedia|youtube|facebook|instagram|pinterest|quora|discord|notion|figma|vercel|netlify)/i.test(host)) continue;
    if (!hints.test(host + u.pathname)) continue;
    let base = `https://${host}`;
    const m = u.pathname.match(/^(\/[^/]*(?:v\d+|api|openai|anthropic)[^/]*)/i);
    if (m) base += m[1].replace(/\/$/, "");
    out.push({ url: base, name: host });
  }
  return out;
}

// 三级 LLM 降级：网关 → 直连 → 规则
async function llmExtract(prompt, links) {
  // 顺序即优先级：
  //   网关   —— 本地最快，且自举（用我们聚合的免费模型跑我们自己的维护任务）
  //   GitHub Models —— CI 最可靠：共享出口 IP 容易把免费来源打限流，
  //                   而 GITHUB_TOKEN 走官方通道不受影响，且零配置
  //   直连   —— 用户自备 key 时的兜底
  //   规则   —— 完全不用 LLM 也能出结果
  const backends = [
    { name: "网关(auto)", fn: callGateway },
    { name: "GitHubModels", fn: callGitHubModels },
    { name: "直连API", fn: callDirect },
  ];
  for (const be of backends) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        log(`    [LLM:${be.name}] 第${attempt}次尝试…`);
        const { text, model } = await be.fn(prompt);
        const got = extractLines(text);
        if (got.length) {
          log(`    [LLM:${be.name}] ✓ 模型=${model} 提取 ${got.length} 条`);
          return { source: be.name, model, items: got };
        }
        log(`    [LLM:${be.name}] 输出为空或格式不符，重试`);
      } catch (e) {
        log(`    [LLM:${be.name}] 失败: ${e.message}`);
      }
      if (attempt < 2) await sleep(1500);
    }
  }
  const items = ruleExtract(links);
  log(`    [LLM:规则兜底] 提取 ${items.length} 条`);
  return { source: "规则兜底", model: null, items };
}

// ── 归一化 ────────────────────────────────────────────────────────
function normalize(items) {
  const seen = new Set();
  const out = [];
  for (const it of items) {
    let base = String(it.url || "").trim();
    if (!/^https?:\/\//i.test(base)) base = "https://" + base.replace(/^\/+/, "");
    let u;
    try { u = new URL(base); } catch { continue; }
    if (!/^https?:$/.test(u.protocol)) continue;
    base = u.toString().replace(/\/+$/, "");
    const host = u.hostname;
    if (/^(www\.|docs\.|github|gitlab|stackoverflow|medium|reddit|twitter|x\.com|linkedin|youtube|facebook|instagram|pinterest|quora|discord|notion|figma|vercel|netlify|wikipedia|zhihu|jianshu|csdn)/i.test(host)) continue;
    if (seen.has(base)) continue;
    seen.add(base);
    out.push({
      label: (it.name || host).replace(/\s+/g, " ").trim() || host,
      base,
      testModel: null,
      note: "",
    });
  }
  return out;
}

// ── main ──────────────────────────────────────────────────────────
async function main() {
  const queries = process.env.SEARCH_QUERY ? [process.env.SEARCH_QUERY] : DEFAULT_QUERIES;

  const all = [];
  const report = { generatedAt: new Date().toISOString(), queries, searchBackend: null, llmBackend: null, rounds: [] };

  for (const q of queries) {
    log(`\n[搜索] ${q}`);
    const round = { query: q, searchBackend: null, llmBackend: null, found: 0 };

    const s = await searchWeb(q);
    if (!s) {
      log("    所有搜索后端都失败，跳过这一轮");
      report.rounds.push(round);
      continue;
    }
    round.searchBackend = s.backend;
    report.searchBackend = report.searchBackend || s.backend;

    const linkBlock = s.links.slice(0, 40).join("\n");
    const prompt = `Search results for "${q}":\n${linkBlock}\n\nList the AI/LLM API provider URLs from these results.`;

    const ex = await llmExtract(prompt, s.links);
    round.llmBackend = ex.source;
    report.llmBackend = report.llmBackend || ex.source;

    const cands = normalize(ex.items);
    round.found = cands.length;
    for (const c of cands) all.push(c);
    log(`    → 本轮候选 ${cands.length} 个`);
    report.rounds.push(round);
  }

  // 种子兜底：一条候选都没有时，注入已知候选（仍需实测才算数）
  if (!all.length) {
    log("\n[兜底] 没有任何候选，注入种子列表等待实测");
    for (const b of SEED_BASES) {
      all.push({ label: new URL(b).hostname, base: b, testModel: null, note: "种子兜底" });
    }
  }

  const seen = new Set();
  const uniq = all.filter((c) => (seen.has(c.base) ? false : (seen.add(c.base), true)));

  const out = { ...report, candidates: uniq };
  const file = path.join(ROOT, "candidates.json");
  fs.writeFileSync(file, JSON.stringify(out, null, 2) + "\n", "utf8");
  log(`\n候选清单写入 ${path.relative(ROOT, file)}（${uniq.length} 个）`);
  log(`搜索后端: ${report.searchBackend || "无"} · LLM后端: ${report.llmBackend || "无"}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
