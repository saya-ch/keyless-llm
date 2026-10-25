#!/usr/bin/env node
/**
 * egress-scan.mjs — 多出口探测：逐个切换 Clash 节点，实测每个出口能用哪些免费模型
 *
 * 用法:
 *   node scripts/egress-scan.mjs                 # 自动挑 直连 + 日/美/新 各一个
 *   node scripts/egress-scan.mjs --models 3      # 每个出口只测 3 个模型（快）
 *   node scripts/egress-scan.mjs --nodes "a,b,c" # 指定节点
 *   node scripts/egress-scan.mjs --dry           # 只列出候选，不切换
 *
 * 输出: egress.json  { group, original, scannedAt, results: [...] }
 */
import http from "node:http";
import https from "node:https";
import fs from "node:fs";
import path from "node:path";

const __dirname = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const ROOT = path.resolve(__dirname, "..");
const CLASH_YAML = process.env.CLASH_YAML ||
  "C:/Users/20655/AppData/Roaming/io.github.clash-verge-rev.clash-verge-rev/clash-verge.yaml";
const GROUP = process.env.KEYLESS_EGRESS_GROUP || process.env.OC2FREE_EGRESS_GROUP || "🐟漏网之鱼";
const OUT = path.join(ROOT, "egress.json");
// 默认经本地网关发起（这样扫描的是"当前出口下网关能否出结果"，与来源无关）
const GATEWAY_PORT = parseInt(process.env.PORT || "8788", 10);
const GATEWAY_KEY = process.env.KEYLESS_KEY || process.env.OC2FREE_KEY || "sk-keyless-local";
const UPSTREAM = process.env.KEYLESS_UPSTREAM || process.env.OC2FREE_UPSTREAM || `http://127.0.0.1:${GATEWAY_PORT}/v1`;

const args = process.argv.slice(2);
function arg(n, d) {
  const i = args.indexOf("--" + n);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
}
const MODEL_LIMIT = parseInt(arg("models", "3"), 10);
const NODES_ARG = arg("nodes", "");
const DRY = args.includes("--dry");

// ── Clash 控制 API（命名管道）─────────────────────────────────────
function pipeName() {
  try {
    const live = fs.readdirSync("\\\\.\\pipe\\").filter((n) => /mihomo/i.test(n));
    if (live.length) return "\\\\.\\pipe\\" + live[0];
  } catch {}
  const txt = fs.readFileSync(CLASH_YAML, "utf8");
  const m = /external-controller-pipe:\s*(\S+)/.exec(txt);
  return m ? m[1].replace(/^\\\\.\\pipe\\/, "\\\\.\\pipe\\") : null;
}
function secret() {
  try {
    return (/^secret:\s*(\S+)/m.exec(fs.readFileSync(CLASH_YAML, "utf8")) || [])[1] || "";
  } catch {
    return "";
  }
}
const PIPE = pipeName();
if (process.env.KEYLESS_DEBUG) {
  console.error("[debug] PIPE=", JSON.stringify(PIPE), "secret=", JSON.stringify(secret()));
  try {
    console.error("[debug] pipes=", fs.readdirSync("\\\\.\\pipe\\").filter((n) => /mihomo|clash/i.test(n)));
  } catch (e) {
    console.error("[debug] readdir failed", e.message);
  }
}

function api(method, apiPath, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = http.request(
      {
        socketPath: PIPE,
        path: apiPath, // 命名管道下需以 // 开头（Mihomo 侧等价 /proxies）
        method,
        headers: {
          Authorization: "Bearer " + secret(),
          Host: "localhost",
          ...(payload ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } : {}),
        },
      },
      (res) => {
        let b = "";
        res.on("data", (d) => (b += d));
        res.on("end", () => resolve({ status: res.statusCode, body: b }));
      }
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function readProxies() {
  const r = await api("GET", "/proxies");
  if (r.status !== 200) throw new Error("GET /proxies -> " + r.status);
  return JSON.parse(r.body);
}

async function switchNode(name) {
  const r = await api("PUT", "/proxies/" + encodeURIComponent(GROUP), { name });
  return r.status === 204 || r.status === 200;
}

// ── 出口探测 ─────────────────────────────────────────────────────
// 关键：必须每次新建 TCP 连接。Node 的 fetch 有连接池，切节点后会复用旧连接，
// 导致出口 IP 不变（表现就是所有出口测出同一个 IP）。
function rawRequest(url, { method = "GET", headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const mod = u.protocol === "https:" ? https : http;
    const req = mod.request(
      {
        hostname: u.hostname,
        port: u.port || (u.protocol === "https:" ? 443 : 80),
        path: u.pathname + u.search,
        method,
        headers,
        agent: false, // 不复用连接
      },
      (res) => {
        let b = "";
        res.on("data", (d) => (b += d));
        res.on("end", () => resolve({ status: res.statusCode, body: b }));
      }
    );
    req.setTimeout(20000, () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}
const httpsRequest = rawRequest; // 兼容旧调用

async function egressIp() {
  try {
    const res = await httpsRequest("https://www.cloudflare.com/cdn-cgi/trace");
    const t = res.body;
    return { ip: (/^ip=(.+)$/m.exec(t) || [])[1] || "?", loc: (/^loc=(.+)$/m.exec(t) || [])[1] || "?" };
  } catch (e) {
    return { ip: "?", loc: "?", error: e.message };
  }
}

async function probeModel(model) {
  const t0 = Date.now();
  try {
    const res = await httpsRequest(`${UPSTREAM}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "keyless-llm/1.0",
        Authorization: "Bearer " + GATEWAY_KEY,
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: "hi" }],
        max_tokens: 16,
        stream: false,
      }),
    });
    const text = res.body;
    if (res.status === 200) return { status: 200, ms: Date.now() - t0 };
    let type = "";
    try {
      const j = JSON.parse(text);
      type = (j.error && (j.error.type || j.error.message)) || j.type || "";
    } catch {}
    return { status: res.status, type: String(type).slice(0, 60), ms: Date.now() - t0 };
  } catch (e) {
    return { status: 0, type: e.message === "timeout" ? "timeout" : e.message.slice(0, 40), ms: Date.now() - t0 };
  }
}

// ── 主流程 ───────────────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  if (!PIPE) {
    console.error("找不到 Mihomo 管道，无法切换出口");
    process.exit(1);
  }
  const proxies = await readProxies();
  const grp = proxies.proxies[GROUP];
  if (!grp) {
    console.error("组不存在:", GROUP);
    process.exit(1);
  }
  const pool = grp.all || [];
  const original = grp.now;
  console.log(`组 ${GROUP}  当前=${original}  可选=${pool.length}  DIRECT在池中=${pool.includes("DIRECT")}`);

  let candidates = [];
  if (NODES_ARG) {
    candidates = NODES_ARG.split(",").map((s) => s.trim()).filter(Boolean);
  } else {
    if (pool.includes("DIRECT")) candidates.push("DIRECT");
    for (const kw of ["日本", "美国", "新加坡"]) {
      const hit = pool.find((n) => n.includes(kw) && /0\.1倍/.test(n));
      if (hit) candidates.push(hit);
    }
  }
  candidates = [...new Set(candidates)];
  console.log("候选:", candidates);

  // 测哪些模型：从本地网关的"当前可用"里取，这样对任意来源都成立
  let free = [];
  try {
    const st = await rawRequest(`${UPSTREAM}/status`, { headers: { Authorization: "Bearer " + GATEWAY_KEY } });
    const j = JSON.parse(st.body);
    free = (j.models || []).filter((m) => m.state === "healthy").map((m) => m.id);
    if (!free.length) free = (j.models || []).slice(0, 6).map((m) => m.id);
  } catch (e) {
    console.error("读取网关状态失败（网关是否已启动？）:", e.message);
    process.exit(1);
  }
  if (MODEL_LIMIT > 0) free = free.slice(0, MODEL_LIMIT);
  if (!free.length) {
    console.error("网关当前没有可用模型，先按 R 做一次轻探测");
    process.exit(1);
  }
  console.log("测试模型:", free);

  if (DRY) return;

  const results = [];
  try {
    for (const node of candidates) {
      if (node !== "DIRECT" && !pool.includes(node)) {
        console.log(`跳过（不在池中）: ${node}`);
        continue;
      }
      console.log(`\n=== 切到 ${node} ===`);
      const ok = await switchNode(node);
      if (!ok) {
        console.log("  切换失败");
        continue;
      }
      await sleep(1800); // 等连接建立/旧连接退场
      const ip = await egressIp();
      console.log(`  出口 ${ip.ip} (${ip.loc})`);
      const models = {};
      let healthy = 0;
      for (const m of free) {
        const r = await probeModel(m);
        models[m] = r.status === 200 ? "ok" : String(r.status || r.type);
        if (r.status === 200) healthy++;
        process.stdout.write(`  ${m}: ${models[m]}  `);
      }
      console.log("");
      results.push({ egress: node, ip: ip.ip, loc: ip.loc, ok: healthy, total: free.length, models });
    }
  } finally {
    console.log(`\n恢复原出口: ${original}`);
    await switchNode(original);
  }

  const payload = {
    group: GROUP,
    original,
    scannedAt: Date.now(),
    results,
  };
  fs.writeFileSync(OUT, JSON.stringify(payload, null, 1));
  console.log("\n=== 汇总 ===");
  for (const r of results) console.log(`  ${(r.loc || "?").padEnd(3)} ${String(r.ok).padStart(2)}/${r.total}  ${r.ip.padEnd(16)} ${r.egress}`);
  console.log("写入", OUT);
})().catch((e) => {
  console.error("FATAL", e);
  process.exit(1);
});
