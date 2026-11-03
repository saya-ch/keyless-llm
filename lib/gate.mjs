/**
 * 来源级并发闸：限制单个来源的在途请求数，防止「自己打爆自己」的免费配额。
 *
 * 免鉴权额度普遍按 IP 计，同一来源打太多并发只会把自己打限流。
 * 闸只覆盖「发起请求 → 收到响应头」这一段——限流计数发生在请求时刻，
 * 响应体读取不占闸，流式长响应不会被卡住。
 *
 * 从 server.mjs 抽出为独立模块，便于离线测试（server.mjs 启动即监听，无法 import）。
 */

export function createGates(concurrency, maxWaiters = 8) {
  const gates = new Map(); // pid -> {active, waiters:[]}

  /**
   * 申请一个槽位。
   * @returns {Promise<Function|null>} 拿到槽位返回 release 函数；
   *   排队已满返回 null（调用方应放弃该来源、换模型重试）。
   * 立即拿到槽位时也返回 Promise，调用方一律 await —— 避免
   * 「不排队时是函数、排队时是 Promise」两种返回类型混用。
   */
  async function acquire(pid) {
    const g = gates.get(pid) || { active: 0, waiters: [] };
    gates.set(pid, g);
    // release 只负责让出槽位并唤醒一个排队者；active 的增减由 acquire 侧负责，
    // 否则「释放 + 唤醒」会重复计数，使 active 单调攀升、真实并发额度被锁死。
    const release = () => {
      g.active--;
      const w = g.waiters.shift();
      if (w) w();
    };
    if (g.active < concurrency) {
      g.active++;
      return release;
    }
    if (g.waiters.length >= maxWaiters) return null;
    return new Promise((resolve) => g.waiters.push(() => { g.active++; resolve(release); }));
  }

  return { acquire, gates };
}
