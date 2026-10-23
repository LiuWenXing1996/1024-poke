// ============ 随机 ============
// 种子随机（与 legacy/sim/sim.mjs 同款算法）。状态挂在 S.rngState 上（可 JSON 序列化），
// 自动存档恢复时用 makeRng(S.rngState) 重建闭包，随机流从断点处无缝接上
export function makeRng(state: { a: number }) {
  return function () {
    state.a = (state.a + 0x6d2b79f5) | 0
    let t = Math.imul(state.a ^ (state.a >>> 15), 1 | state.a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function shuffle<T>(a: T[], rnd: () => number = Math.random): T[] {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]]
  }
  return a
}
