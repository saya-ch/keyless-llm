#!/usr/bin/env node
/**
 * discover-community.mjs — 从社区动态采集候选（discover 的第三条线）
 *
 * 前两条线覆盖「搜索引擎（DuckDuckGo）」和「人工聚合列表（GitHub）」，
 * 缺的是社区动态：有人刚在论坛/HN 分享了一个新的免 key 端点，搜索引擎还没收录。
 *
 * 数据源（都是公开 API、有明确条款、可限频，无需自建爬虫框架）：
 *   - Reddit 搜索 JSON     reddit.com/search.json?q=...      （需要 UA，数据中心 IP 可能被限）
 *   - Hacker News Algolia  hn.algolia.com/api/v1/search       （官方公开 API）
 *   - GitHub 仓库搜索      api.github.com/search/repositories （带 GITHUB_TOKEN 避免限流）
 *
 * 只从返回文本里提取 URL，交给 normalize 过滤：必须是 API 路径、排除已知/已收录/已确认不可行。
 * 输出 candidates-community.json（与前两条线分开，互不覆盖）。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const UA = "keyless-llm-discover/1.0 (+https://github.com/saya-ch/keyless-llm)";
const API_PATH_RE = /\/(v\d+[a-z]*|api|openai|inference)\b/i;
// 排除「来源站自己」和非 API 站点
const EXCLUDE_HOST_RE = /^(github\.com|raw\.githubusercontent\.com|gist\.github\.com|news\.ycombinator\.com|hn\.algolia\.com|reddit\.com|old\.reddit\.com|docs\.|console\.|aistudio\.|ai\.google\.dev|platform\.|accounts\.google|cloud\.|developers\.|blog\.|medium\.|twitter\.com|x\.com|www\.|forum\.|community\.)/i;

const QUERIES = process.env.SEARCH_QUERY ? [process.env.SEARCH_QUERY] : [
  "free llm api no api key",
  "openai compatible endpoint no signup",
  "免鉴权 大模型 api 免费",
];

const log = (...a) => console.log(...a);

function loadKnownHosts() {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, "providers.json"), "utf8"));
    return new Set((cfg.providers || []).map((p) => {
      try { return new URL(p.base).hostname.toLowerCase(); } catch { return ""; }
    }).filter(Boolean));
  } catch { return new Set(); }
}

function loadRejectedHosts() {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(ROOT, "snapshots", "rejected.json"), "utf8"));
    const cutoff = Date.now() - 30 * 86400000;
    return new Set((j.entries || [])
      .filter((e) => !e.lastChecked || Date.parse(e.lastChecked) > cutoff)
      .map((e) => { try { return new URL(e.base).hostname.toLowerCase(); } catch { return ""; } })
      .filter(Boolean));
  } catch { return new Set(); }
}

function extractUrls(text) {
  const out = new Set();
  const re = /https?:\/\/[^\s\)\]"'<>,]+/g;
  let m;
  while ((m = re.exec(text))) out.add(m[0].replace(/[.,;)]+$/, ""));
  return [...out];
}

function normalize(urls, knownHosts, rejectedHosts) {
  const seen = new Set();
  const out = [];
  for (let base of urls) {
    base = String(base || "").replace(/[.,;)]+$/, "").trim();
    if (base.includes("{") || base.includes("}")) continue;
    let u;
    try { u = new URL(base); } catch { continue; }
    if (!/^https?:$/.test(u.protocol)) continue;
    const host = u.hostname.toLowerCase();
    if (EXCLUDE_HOST_RE.test(host)) continue;
    if (knownHosts.has(host)) continue;
    if (rejectedHosts.has(host)) continue;
    if (!API_PATH_RE.test(u.pathname)) continue;
    base = base.replace(/\/+$/, "");
    if (seen.has(base)) continue;
    seen.add(base);
    out.push({ label: host, base, testModel: null, note: "", source: "community" });
  }
  return out;
}

async function fetchReddit(q) {
  const url = `https://www.reddit.com/search.json?q=${encodeURIComponent(q)}&sort=new&limit=50`;
  const r = await fetch(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error("HTTP " + r.status);
  const j = await r.json();
  const posts = j?.data?.children?.map((c) => c.data) || [];
  return posts.map((p) => `${p.title || ""}\n${p.selftext || ""}\n${p.url || ""}`).join("\n");
}

async function fetchHN(q) {
  const url = `https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(q)}&tags=story&hitsPerPage=50`;
  const r = await fetch(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error("HTTP " + r.status);
  const j = await r.json();
  return (j.hits || []).map((h) => `${h.title || ""}\n${h.url || ""}\n${h.story_text || ""}`).join("\n");
}

async function fetchGithubRepos(q) {
  const url = `https://api.github.com/search/repositories?q=${encodeURIComponent(q)}&sort=updated&per_page=20`;
  const headers = { "User-Agent": UA, Accept: "application/vnd.github+json" };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const r = await fetch(url, { headers, signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error("HTTP " + r.status);
  const j = await r.json();
  return (j.items || []).map((it) => `${it.full_name || ""}\n${it.description || ""}\n${it.homepage || ""}`).join("\n");
}

const SOURCES = [
  ["reddit", fetchReddit],
  ["hackernews", fetchHN],
  ["github-repos", fetchGithubRepos],
];

// 可选：用网关的 auto 模型审核候选（网关不可用则跳过，返回 null）
// 目的：把教程页/注册页/仓库页这类噪音先滤掉，减少下游无效验证
async function refineWithAgent(cands) {
  if (!cands.length) return cands;
  const GATEWAY = (process.env.KEYLESS_GATEWAY || "http://127.0.0.1:8788").replace(/\/+$/, "");
  const KEY = process.env.KEYLESS_KEY || "sk-keyless-local";
  const listText = cands.map((c, i) => `${i + 1}. ${c.base}`).join("\n");
  const prompt = `以下是从 Reddit / Hacker News / GitHub 采集到的 URL 列表。请判断其中哪些「可能是无需 API key 即可直接调用的 AI/LLM API 端点」——即真正的 OpenAI 兼容 API base URL（形如 https://api.xxx.com/v1）；排除教程页、注册页、文档、GitHub 仓库页面、作者博客等。只输出符合的 URL，每行一个，不要编号、不要解释。\n\n${listText}`;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 60000);
    const r = await fetch(`${GATEWAY}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${KEY}` },
      body: JSON.stringify({
        model: process.env.KEYLESS_MODEL || "auto",
        max_tokens: 800, stream: false,
        messages: [{ role: "user", content: prompt }],
      }),
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (!r.ok) throw new Error("HTTP " + r.status);
    const j = await r.json();
    const text = j.choices?.[0]?.message?.content || "";
    const passed = new Set(extractUrls(text).map((u) => u.replace(/\/+$/, "")));
    return cands.filter((c) => passed.has(c.base));
  } catch (e) {
    log(`[agent 审核] 跳过（网关不可用: ${e.message}）`);
    return null;
  }
}

async function main() {
  const known = loadKnownHosts();
  const rejected = loadRejectedHosts();
  log(`已收录 host: ${known.size} · 已确认不可行 host: ${rejected.size}`);

  const sources = [];
  const allUrls = [];
  for (const q of QUERIES) {
    for (const [name, fn] of SOURCES) {
      try {
        const text = await fn(q);
        const urls = extractUrls(text);
        allUrls.push(...urls);
        sources.push({ source: name, query: q, urls: urls.length });
        log(`[${name}] "${q}" → ${urls.length} 个 URL`);
      } catch (e) {
        sources.push({ source: name, query: q, error: e.message });
        log(`[${name}] "${q}" 失败: ${e.message}`);
      }
    }
  }

  const uniq = [...new Set(allUrls)];
  let cands = normalize(uniq, known, rejected);
  log(`\n规范化后候选 ${cands.length} 个`);
  // agent 审核：网关可用时先用 auto 模型过滤噪音
  if (cands.length) {
    const refined = await refineWithAgent(cands);
    if (refined !== null) {
      log(`[agent 审核] ${cands.length} → ${refined.length} 个`);
      cands = refined;
    }
  }
  const out = { generatedAt: new Date().toISOString(), sources, candidates: cands };
  const file = path.join(ROOT, "candidates-community.json");
  fs.writeFileSync(file, JSON.stringify(out, null, 2) + "\n", "utf8");
  log(`\n社区候选写入 ${path.relative(ROOT, file)}：URL ${uniq.length} 个 → 候选 ${cands.length} 个`);
  for (const c of cands) log(`  ${c.base}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
