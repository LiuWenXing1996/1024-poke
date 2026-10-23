// ============ 游戏状态（reactive）与持久化 ============
import { reactive, ref } from 'vue'
import { freshState } from '../engine/engine'
import type { Card, EngineState, HuRecord, TableToken } from '../engine/types'

export interface ActionLogEntry { type: 'place' | 'discard' | 'draw' | 'hu'; text: string }

export interface GameState {
  deck: Card[]
  hand: Card[]
  table: TableToken[]
  st: EngineState
  hu: number
  huLog: HuRecord[]          // 本局胡牌记录：{expr}（点桌角「胡」徽章回看）
  actionLog: ActionLogEntry[] // 本局操作流水（随自动存档持久化；撤销随快照回滚）
  gid: number                // 局 ID（存档槽主键，防同毫秒开局撞号）
  placedThisHand: number     // 距上次胡的连续出牌数
  undoStack: string[]        // 操作快照（JSON，落子/弃牌前压入；胡牌后清空——胡不可撤销）
  discarded: number          // 本局已弃张数（弃牌移出本局，不洗回）
  discardPile: Card[]        // 弃牌堆实体（供详情查看）
  seed: number               // 局种子（存档「重开」可复盘）
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
  gid: 0,
  placedThisHand: 0,
  undoStack: [],
  discarded: 0,
  discardPile: [],
  seed: 0,
  rngState: { a: 0 },
  best: Number(store.get('h1024.best') || 0),
})

// ---- UI 轻状态：弹层 + 特效 ----
export type SheetKind = 'help' | 'start' | 'restart' | 'pickNum' | 'pickOp' | 'pile' | 'huLog' | 'saves' | 'confirmDelSave' | 'confirmClearSave'
export interface SheetState { kind: SheetKind; payload?: Record<string, unknown> }

// 弹窗栈：每个弹窗是独立实例，叠加显示互不挤掉；后开的在上层
export const sheets = ref<SheetState[]>([])
export const openSheet = (kind: SheetKind, payload?: Record<string, unknown>) => { sheets.value.push(payload ? { kind, payload } : { kind }) }
export const closeSheet = () => { sheets.value.pop() }

export const fx = reactive({ toast: '', toastAt: 0, burstAt: 0, drawAt: 0, drawFrom: 'deck' as 'deck' | 'discard', returnAt: 0, returnSlots: [] as number[], undoPlaceAt: 0, undoPlaceSlot: 0 })
export function toast(msg: string) { fx.toast = msg; fx.toastAt++ }

// ---- 持久化 ----
// 自动存档：整局状态落盘（rngState 可序列化，恢复后随机流从断点接上）
// 复盘会话（URL 带 ?seed=）不落盘，避免复盘覆盖正在进行的对局
// 存档槽同步走 upsertSave（入账点：胡牌/新局；恢复局时经 restoreGame）
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

// ---- 存档：每局一份可恢复快照（对局数据的唯一持久层，「历史记录」概念已并入存档） ----
interface SaveSlot { ts: number; snap: string }
const STATES_KEY = 'h1024.states'
const STATES_CAP = 50
export function loadStates(): Record<string, SaveSlot> {
  try {
    const raw = JSON.parse(store.get(STATES_KEY) || '{}') as Record<string, SaveSlot | string>
    const out: Record<string, SaveSlot> = {}
    for (const [gid, v] of Object.entries(raw)) {
      // 旧格式是纯快照字符串 → 迁移包装（ts=0 排最旧，下次落槽自然刷新）
      out[gid] = typeof v === 'string' ? { ts: 0, snap: v } : v
    }
    return out
  } catch { return {} }
}
function writeStates(states: Record<string, SaveSlot>) {
  // 按 ts 降序只留最近 STATES_CAP 份，防配额爆
  const pruned = Object.entries(states)
    .sort((a, b) => b[1].ts - a[1].ts)
    .slice(0, STATES_CAP)
  try { store.set(STATES_KEY, JSON.stringify(Object.fromEntries(pruned))) } catch { /* 配额满：静默放弃 */ }
}
export function deleteSave(gid: number) {
  const states = loadStates()
  if (!states[String(gid)]) return
  delete states[String(gid)]
  writeStates(states)
}
export function clearSaves() {
  try {
    localStorage.removeItem(STATES_KEY)
    localStorage.removeItem(LOGS_KEY)
  } catch { /* noop */ }
  lastLogWriteLen = -1
  upsertSave()   // 清空也保留当前对局的存档
}
function gameSnapshot(): string {
  const snap = JSON.parse(JSON.stringify(S)) as Record<string, unknown>
  delete snap.undoStack   // 撤销栈不随快照（恢复后从零可撤）
  delete snap.actionLog   // 流水从流水桶回灌，不重复存
  return JSON.stringify(snap)
}
// 当前局快照落槽（ts=最近游玩时间，随入账刷新）
function syncSaveSlot() {
  const states = loadStates()
  states[String(S.gid)] = { ts: Date.now(), snap: gameSnapshot() }
  writeStates(states)
}
let lastLogWriteLen = -1
let lastLogWriteAt = 0
// 入账：快照落槽 + 流水桶同步（final=局终了必写流水；平时 1.5s 节流 + 长度变了才写）
export function upsertSave(final = false) {
  // 首次启动的幽灵局（seed 0）不记
  if (S.seed === 0) return
  syncSaveSlot()
  const now = Date.now()
  if (S.actionLog.length !== lastLogWriteLen && (final || now - lastLogWriteAt > 1500)) {
    const logs = loadLogs()
    logs[String(S.gid)] = S.actionLog.slice(-500)
    writeLogs(logs)
    lastLogWriteLen = S.actionLog.length
    lastLogWriteAt = now
  }
}
// 操作流水桶：gid -> 流水（每局上限 500 条，随存档清理）
const LOGS_KEY = 'h1024.gamelogs'
function loadLogs(): Record<string, ActionLogEntry[]> {
  try { return JSON.parse(store.get(LOGS_KEY) || '{}') as Record<string, ActionLogEntry[]> } catch { return {} }
}
function writeLogs(logs: Record<string, ActionLogEntry[]>) {
  // 只保留还有存档的局，防流水桶无限膨胀
  const states = loadStates()
  const pruned: Record<string, ActionLogEntry[]> = {}
  for (const gid of Object.keys(states)) if (logs[gid]) pruned[gid] = logs[gid]
  try { store.set(LOGS_KEY, JSON.stringify(pruned)) } catch { /* 配额满：流水是附属数据，静默放弃 */ }
}
export function loadGameLog(gid: number): ActionLogEntry[] {
  if (gid === S.gid) return S.actionLog            // 当前局：内存即最新
  return loadLogs()[String(gid)] ?? []
}
// 恢复存档：先把当前局快照落槽（进度不丢、流水入桶），再换入目标局；成功返回 true
export function restoreGame(gid: number): boolean {
  if (gid === S.gid) return false
  const states = loadStates()
  const slot = states[String(gid)]
  if (!slot) return false
  const logs = loadLogs()
  logs[String(S.gid)] = S.actionLog.slice(-500)   // 当前局流水落桶
  writeLogs(logs)
  syncSaveSlot()                                   // 当前局快照落槽
  Object.assign(S, JSON.parse(slot.snap), { undoStack: [], actionLog: loadGameLog(gid) })
  lastLogWriteLen = -1
  saveGame()
  upsertSave()
  return true
}
