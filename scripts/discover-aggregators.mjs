#!/usr/bin/env node
/**
 * discover-aggregators.mjs — 从高质量聚合源采集候选端点（discover 的第二条线）
 *
 * 与 discover-with-agent.mjs（全网搜索）并行：
 *   全网搜索：召回广但噪音大（中转站、教程页）
 *   聚合源：人工维护的免费 LLM API 列表，噪音小、更新及时
 *
 * 数据源（都在 GitHub，CI 里直连）：
 *   - freellms/free-openai-compatible-api  （表格：| Provider | Base URL |）
 *   - mnfst/awesome-free-llm-apis          （Base URL: `...`）
 *   - konglong87/free-AI-free-token        （Base URL / API 链接）
 *
 * 去重：读取 providers.json（已收录）与 snapshots/rejected.json（已确认不可行）的 host，
 *   命中的直接丢弃。本脚本只读 rejected，不写（避免和 discover 主线的提交竞争）。
 *
 * 输出：candidates-aggregators.json（与主线的 candidates.json 分开，互不覆盖）
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const AGGREGATORS = [
  { name: "freellms", type: "md", url: "https://raw.githubusercontent.com/freellms/free-openai-compatible-api/main/README.md" },
  { name: "awesome-free-llm-apis", type: "md", url: "https://raw.githubusercontent.com/mnfst/awesome-free-llm-apis/main/README.md" },
  { name: "free-AI-free-token", type: "md", url: "https://raw.githubusercontent.com/konglong87/free-AI-free-token/main/README.md" },
  { name: "free-llm-api", type: "json", url: "https://raw.githubusercontent.com/xyzs996/free-llm-api/main/data/providers.json" },
];

// 只收「像 API 端点」的路径，避免把文档站、控制台、图片当成 API
const API_PATH_RE = /\/(v\d+[a-z]*|api|openai|inference)\b/i;
// 明显不是 API 的域名/子域
const EXCLUDE_HOST_RE = /^(github\.com|raw\.githubusercontent\.com|gist\.github\.com|docs\.|console\.|aistudio\.|ai\.google\.dev|platform\.|accounts\.google|cloud\.|developers\.|blog\.|medium\.|reddit\.|twitter\.com|x\.com|www\.|forum\.|community\.)/i;

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

// 从 markdown 里提取 (url, label)
function extractUrls(text) {
  const out = new Map();
  let m;
  // 1) "Base URL: `https://...`"
  const re1 = /Base URL[:：]\s*`(https?:\/\/[^`\s]+)`/gi;
  while ((m = re1.exec(text))) out.set(m[1].trim(), out.get(m[1].trim()) || "");
  // 2) 表格行：| label | `https://...` |
  const re2 = /\|\s*([^|\n]{2,40}?)\s*\|\s*`(https?:\/\/[^`\s]+)`/g;
  while ((m = re2.exec(text))) {
    const base = m[2].trim();
    if (!out.has(base) || !out.get(base)) out.set(base, m[1].trim());
  }
  // 3) HTML 链接：<a href="https://...">（free-AI-free-token 用这种格式）
  //    会把注册页/文档也带进来，交给 normalize 的 API_PATH_RE / EXCLUDE_HOST_RE 过滤
  const re3 = /<a\s+href="(https?:\/\/[^"]+)"/gi;
  while ((m = re3.exec(text))) out.set(m[1].trim(), out.get(m[1].trim()) || "");
  return [...out.entries()].map(([url, label]) => ({ url, label }));
}

// xyzs996/free-llm-api 的 data/providers.json：数组，base_url 字段
function extractFromJson(text) {
  const arr = JSON.parse(text);
  const list = Array.isArray(arr) ? arr : (arr.providers || []);
  return list
    .map((p) => ({ url: p.base_url || p.baseUrl || p.base || "", label: p.name || p.id || "" }))
    .filter((x) => x.url);
}

function normalize(items, knownHosts, rejectedHosts) {
  const seen = new Set();
  const out = [];
  for (const it of items) {
    let base = String(it.url || "").replace(/[.,;)]+$/, "").trim();
    if (base.includes("{") || base.includes("}")) continue;   // 模板化 URL（{account_id} 等）跳过
    if (/ACCOUNT_ID|YOUR_|API_KEY|_ID\//i.test(base)) continue; // 其它占位符写法
    let u;
    try { u = new URL(base); } catch { continue; }
    if (!/^https?:$/.test(u.protocol)) continue;
    const host = u.hostname.toLowerCase();
    if (EXCLUDE_HOST_RE.test(host)) continue;
    if (knownHosts.has(host)) continue;        // 已收录
    if (rejectedHosts.has(host)) continue;     // 已确认不可行
    if (!API_PATH_RE.test(u.pathname)) continue;
    base = base.replace(/\/+$/, "");
    if (seen.has(base)) continue;
    seen.add(base);
    out.push({ label: (it.label || host).replace(/\s+/g, " ").trim() || host, base, testModel: null, note: "", source: it.source });
  }
  return out;
}

async function main() {
  const known = loadKnownHosts();
  const rejected = loadRejectedHosts();
  log(`已收录 host: ${known.size} · 已确认不可行 host: ${rejected.size}`);

  const all = [];
  const sources = [];
  for (const a of AGGREGATORS) {
    try {
      const r = await fetch(a.url, { headers: { "User-Agent": "keyless-llm-discover/1.0" }, signal: AbortSignal.timeout(30000) });
      if (!r.ok) throw new Error("HTTP " + r.status);
      const text = await r.text();
      const rawItems = a.type === "json" ? extractFromJson(text) : extractUrls(text);
      const items = rawItems.map((x) => ({ ...x, source: a.name }));
      const cands = normalize(items, known, rejected);
      sources.push({ name: a.name, url: a.url, extracted: items.length, candidates: cands.length });
      all.push(...cands);
      log(`[${a.name}] 提取 ${items.length} 个 URL，过滤后 ${cands.length} 个候选`);
    } catch (e) {
      sources.push({ name: a.name, url: a.url, error: e.message });
      log(`[${a.name}] 失败: ${e.message}`);
    }
  }

  const seen = new Set();
  const uniq = all.filter((c) => (seen.has(c.base) ? false : (seen.add(c.base), true)));
  const out = { generatedAt: new Date().toISOString(), sources, candidates: uniq };
  const file = path.join(ROOT, "candidates-aggregators.json");
  fs.writeFileSync(file, JSON.stringify(out, null, 2) + "\n", "utf8");
  log(`\n聚合源候选写入 ${path.relative(ROOT, file)}（${uniq.length} 个）`);
  for (const c of uniq) log(`  ${c.base}  [${c.source}]`);
}

main().catch((e) => { console.error(e); process.exit(1); });
