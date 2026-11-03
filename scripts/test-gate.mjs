#!/usr/bin/env node
/**
 * 来源并发闸离线测试：验证 lib/gate.mjs 的计数与返回值语义。
 * 用法: node scripts/test-gate.mjs
 *
 * 覆盖两个曾经的 bug：
 *   1. 计数泄漏 —— release 里多余的 active++ 使「释放+唤醒」净增 +1，
 *      高并发下 active 单调攀升，真实并发额度被锁死。
 *   2. 返回值不一致 —— 不排队时返回函数、排队时返回 Promise；
 *      调用方没 await 就 release()，TypeError 被当成 network_error，
 *      该模型被误判进冷却。
 */
import { createGates } from "../lib/gate.mjs";

let pass = 0, fail = 0;
function check(name, cond, detail = "") {
  if (cond) { pass++; console.log(`  PASS ${name}`); }
  else { fail++; console.log(`  FAIL ${name} ${detail}`); }
}

const CONC = 3;
const sleep = (ms = 0) => new Promise((r) => setTimeout(r, ms));

async function main() {
  // ── 用例 1：无排队者，纯释放应归零 ──
  {
    console.log("\n[1] 无排队者，释放后计数归零");
    const { acquire, gates } = createGates(CONC);
    const g = () => gates.get("p");
    const held = [];
    for (let i = 0; i < CONC; i++) held.push(await acquire("p"));
    check("占满 3 个", g().active === CONC, `active=${g().active}`);
    for (const r of held) r();
    await sleep();
    check("全部释放后归零", g().active === 0, `active=${g().active}`);
  }

  // ── 用例 2：有排队者时 active 应恒为并发上限（旧代码泄漏到 8）──
  {
    console.log("\n[2] 有排队者时计数稳定（曾泄漏）");
    const { acquire, gates } = createGates(CONC);
    const g = () => gates.get("p");
    const held = [];
    for (let i = 0; i < CONC; i++) held.push(await acquire("p"));
    const pending = [];
    for (let i = 0; i < 5; i++) pending.push(acquire("p"));
    await sleep();
    check("排队 5 个时 active 仍为上限", g().active === CONC, `active=${g().active}`);
    for (let i = 0; i < 5; i++) {
      held.shift()();
      held.push(await pending.shift());
      await sleep();
      check(`释放第 ${i + 1} 个后 active=上限`, g().active === CONC, `active=${g().active}`);
    }
  }

  // ── 用例 3：acquire 一律返回 Promise（旧代码不排队时返回裸函数）──
  // 这是关键契约：只要有一条路径返回同步值，调用方就可能忘记 await，
  // 而排队路径返回 Promise 时 release() 会 TypeError（原 bug 的根因）。
  {
    console.log("\n[3] acquire 一律返回 Promise");
    const { acquire } = createGates(CONC);
    const immediate = acquire("p");
    check("立即拿到槽位返回 Promise", immediate instanceof Promise, `得到 ${typeof immediate}`);
    const held = [await immediate];
    for (let i = 1; i < CONC; i++) held.push(await acquire("p"));
    const queued = acquire("p");
    check("排队时返回 Promise", queued instanceof Promise, `得到 ${typeof queued}`);
    held[0]();
    const r = await queued;
    check("await 后得到 release 函数", typeof r === "function", `得到 ${typeof r}`);
    if (typeof r === "function") { held.push(r); r(); }
  }

  // ── 用例 4：排队超过上限返回 null（provider_busy 降级路径）──
  {
    console.log("\n[4] 排队满返回 null");
    const { acquire } = createGates(CONC);
    const held = [];
    for (let i = 0; i < CONC; i++) held.push(await acquire("p"));
    const pending = [];
    for (let i = 0; i < 8; i++) pending.push(acquire("p"));
    const overflow = await acquire("p");
    check("第 9 个排队者得到 null", overflow === null, `得到 ${overflow === null ? "null" : typeof overflow}`);
    for (const r of held) r();
    for (const r of pending) { const x = await r; if (typeof x === "function") x(); }
  }

  // ── 用例 5：来源隔离，一个来源排队不影响另一个 ──
  {
    console.log("\n[5] 来源之间互不阻塞");
    const { acquire, gates } = createGates(CONC);
    const a = [];
    for (let i = 0; i < CONC; i++) a.push(await acquire("a"));
    const b = await acquire("b");
    check("来源 a 占满时 b 仍可立即获取", typeof b === "function" && gates.get("b").active === 1);
    for (const r of a) r();
    b();
  }

  console.log("");
  if (fail === 0) {
    console.log(`全部通过 (${pass} 项)`);
    process.exit(0);
  }
  console.log(`失败 ${fail} 项 / 通过 ${pass} 项`);
  process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
