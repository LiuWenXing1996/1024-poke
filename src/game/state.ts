// ============ 游戏状态（reactive）与持久化 ============
import { reactive, ref } from 'vue'
import { freshState } from '../engine/engine'
import type { Card, EngineState, HuRecord, TableToken } from '../engine/types'

export interface RunStat { tianHu: number; wangZha: number; naked: number }
export interface HistEntry { seed: number; hu: number; turns: number; ts: number; log?: ActionLogEntry[] }
export interface ActionLogEntry { turn: number; type: 'place' | 'discard' | 'endTurn'; text: string }

export interface GameState {
  deck: Card[]
  hand: Card[]
  table: TableToken[]
  st: EngineState
  hu: number
  huLog: HuRecord[]          // 本局胡牌记录：{expr, gains}（点桌角「胡」徽章回看）
  actionLog: ActionLogEntry[] // 本局操作流水（按回合标注，随自动存档持久化；撤销随快照回滚）
  placedThisTurn: number
  turns: number              // 已结束的回合数（显示回合 = turns + 1）
  run: RunStat
  undoStack: string[]        // 本回合操作快照（JSON，落子/弃牌前压入；跨回合清空）
  discarded: number          // 本局已弃张数（弃牌移出本局，不洗回）
  discardPile: Card[]        // 弃牌堆实体（供详情查看）
  seed: number               // 局种子（历史弹层可复盘）
  rngState: { a: number }    // RNG 内部状态（自动存档后无缝接上随机流）
  best: number               // 历史最高胡数（localStorage 持久化）
}

// 沙箱 iframe 里 localStorage 可能直接抛异常，包一层
export const store = {
  get(k: string) { try { return localStorage.getItem(k) } catch { return null } },
  set(k: string, v: string) { try { localStorage.setItem(k, v) } catch { /* noop */ } },
}

// 复盘链接里的固定种子；无 ?seed= 时为 null
export const URL_SEED = (() => {
  try {
    const s = new URLSearchParams(location.search).get('seed')
    return s && /^\d+$/.test(s) ? Number(s) % 2 ** 31 : null
  } catch { return null }
})()

export const S = reactive<GameState>({
  deck: [],
  hand: [],
  table: [],
  st: freshState(),
  hu: 0,
  huLog: [],
  actionLog: [],
  placedThisTurn: 0,
  turns: 0,
  run: { tianHu: 0, wangZha: 0, naked: 0 },
  undoStack: [],
  discarded: 0,
  discardPile: [],
  seed: 0,
  rngState: { a: 0 },
  best: Number(store.get('h1024.best') || 0),
})

// ---- UI 轻状态：弹层 + 特效 ----
export type SheetKind = 'help' | 'start' | 'restart' | 'pickNum' | 'pickOp' | 'pile' | 'huLog' | 'history'
export interface SheetState { kind: SheetKind; payload?: Record<string, unknown> }
export const sheet = ref<SheetState | null>(null)
export const openSheet = (kind: SheetKind, payload?: Record<string, unknown>) => { sheet.value = payload ? { kind, payload } : { kind } }
export const closeSheet = () => { sheet.value = null }

export const fx = reactive({ toast: '', toastAt: 0, burstAt: 0, drawAt: 0, drawFrom: 'deck' as 'deck' | 'discard' })
export function toast(msg: string) { fx.toast = msg; fx.toastAt++ }

// ---- 持久化 ----
// 自动存档：整局状态落盘（rngState 可序列化，恢复后随机流从断点接上）
// 复盘会话（URL 带 ?seed=）不落盘，避免复盘覆盖正在进行的对局
export const SAVE_KEY = 'h1024.save'
export function saveGame() {
  if (URL_SEED) return
  store.set(SAVE_KEY, JSON.stringify(S))
}
export function resumeGame(): boolean {
  try {
    const d = JSON.parse(store.get(SAVE_KEY) || 'null') as Partial<GameState> | null
    if (!d || !Array.isArray(d.deck) || !d.deck.length) return false
    Object.assign(S, d)          // 缺的字段（旧版存档）保留 S 默认值
    S.hand.forEach(c => { if (c.drawn) delete c.drawn })   // 续玩不重播飞入动画
    return true
  } catch { return false }
}
// 只读取存档摘要（不应用到 S），供开始弹窗显示「继续上局」按钮
export function peekSave(): { hu: number; seed: number } | null {
  try {
    const d = JSON.parse(store.get(SAVE_KEY) || 'null') as Partial<GameState> | null
    if (!d || !Array.isArray(d.deck) || !d.deck.length) return null
    return { hu: d.hu ?? 0, seed: d.seed ?? 0 }
  } catch { return null }
}

// 历史对局：开新局时记下上一局（都留，最近 99999 局；localStorage 持久化）
const HIST_KEY = 'h1024.hist'
const HIST_CAP = 99999
export function loadHist(): HistEntry[] {
  try { return JSON.parse(store.get(HIST_KEY) || '[]') as HistEntry[] } catch { return [] }
}
export function saveHistEntry() {
  // 首次启动的 newGame（seed 还是初始值 0）是幽灵局，不记
  if (S.seed === 0) return
  const hist = loadHist()
  hist.unshift({ seed: S.seed, hu: S.hu, turns: S.turns, ts: Date.now(), log: S.actionLog.slice(-500) })
  writeHist(hist)
}
function writeHist(hist: HistEntry[]) {
  // 写满会顶爆 localStorage 配额且静默失败——对半裁直到写得进
  for (let n = Math.min(hist.length, HIST_CAP); n > 0; n = Math.floor(n / 2)) {
    try { localStorage.setItem(HIST_KEY, JSON.stringify(hist.slice(0, n))); return } catch { /* 满了，裁半重试 */ }
  }
}
export function deleteHistEntry(index: number) {
  const hist = loadHist()
  if (index < 0 || index >= hist.length) return
  hist.splice(index, 1)
  writeHist(hist)
}
export function clearHist() {
  try { localStorage.removeItem(HIST_KEY) } catch { /* noop */ }
}
