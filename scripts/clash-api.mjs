#!/usr/bin/env node
/**
 * clash-api.mjs — 通过 Mihomo 命名管道调用控制 API（只读探测用）
 * 用法: node clash-api.mjs [path]    例: node clash-api.mjs /proxies
 */
import http from "node:http";
import fs from "node:fs";

const CFG = "C:/Users/20655/AppData/Roaming/io.github.clash-verge-rev.clash-verge-rev/clash-verge.yaml";

function readPipe() {
  // 先枚举真实存在的管道（配置里的名字常与运行时不一致）
  try {
    const live = fs.readdirSync("\\\\.\\pipe\\").filter((n) => /verge-mihomo|mihomo/i.test(n));
    if (live.length) return live[0];
  } catch {}
  const txt = fs.readFileSync(CFG, "utf8");
  const m = /external-controller-pipe:\s*(\S+)/.exec(txt);
  return m ? m[1].replace(/^\\\\\.\\pipe\\/, "") : null;
}
function readSecret() {
  const txt = fs.readFileSync(CFG, "utf8");
  const m = /^secret:\s*(\S+)/m.exec(txt);
  return m ? m[1] : "";
}

const path = process.argv[2] || "/proxies";
const pipe = readPipe();
if (!pipe) {
  console.error("no external-controller-pipe in config");
  process.exit(1);
}
const full = "\\\\.\\pipe\\" + pipe;

function get(p) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { socketPath: full, path: p, method: "GET", headers: { Authorization: "Bearer " + readSecret(), Host: "localhost" } },
      (res) => {
        let b = "";
        res.on("data", (d) => (b += d));
        res.on("end", () => resolve({ status: res.statusCode, body: b }));
      }
    );
    req.on("error", reject);
    req.end();
  });
}

const r = await get(path);
console.log("status:", r.status);
try {
  const j = JSON.parse(r.body);
  if (path === "/proxies") {
    const groups = Object.entries(j.proxies || {}).filter(([, v]) => v.type === "Selector" || v.type === "URLTest" || v.type === "Fallback" || v.type === "LoadBalance");
    console.log("groups:", groups.length);
    for (const [name, v] of groups) {
      console.log(`  [${v.type}] ${name}  now=${v.now}  all=${(v.all || []).length}`);
    }
    const hasDirect = Object.keys(j.proxies || {}).filter((k) => /DIRECT|REJECT/i.test(k));
    console.log("direct-like entries:", hasDirect.slice(0, 5));
  } else {
    console.log(r.body.slice(0, 1500));
  }
} catch {
  console.log(r.body.slice(0, 400));
}
