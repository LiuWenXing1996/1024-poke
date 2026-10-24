// ============ 游戏动作（操作 S，每步落盘） ============
import { HAND_SIZE, TARGET, freshState, placeNum, placeOp, val } from '../engine/engine'
import { OP_TO_ENGINE, buildDeck, rankLabel } from '../engine/cards'
import { makeRng, shuffle } from '../engine/rng'
import type { Card, OpSymbol } from '../engine/types'
import { S, URL_SEED, fx, saveGame, upsertSave, store } from './state'
import type { ActionLogEntry } from './state'

// 返回：null 不可放；{ch} 可直接放；{pick:'num'|'op'} 需要选值/选符号
export function placementFor(card: Card): { ch?: number | OpSymbol; pick?: 'num' | 'op' } | null {
  if (S.st.last !== 'n') {                      // 需要数字
    if (card.kind === 'num') {
      if (card.joker) return { pick: 'num' }
      if (S.st.lastOp === '/' && S.st.curV! % card.v !== 0) return null   // ÷ 后必须整除
      return { ch: card.v }
    }
    return null
  }
  if (card.kind === 'op') return card.wild ? { pick: 'op' } : { ch: card.o! }
  return null
}

// 不可打出的原因（placementFor 为 null 时调用），点击不可打的牌时轻提示
export function unplayableReason(card: Card): string {
  if (card.kind === 'op') return '运算符后面只能跟随数字'
  if (S.st.lastOp === '/' && S.st.curV! % card.v !== 0) return '该数字不能被整除'
  return '数字和数字之前必须有运算符'
}

// 手牌座位号：出牌后空位留在原位，补牌坐空位
export function freeSlot(): number {
  for (let s = 0; s < HAND_SIZE; s++) if (!S.hand.some(c => c.slot === s)) return s
  return HAND_SIZE - 1
}

// ---- 快照式撤销：落子/弃牌前压入整局快照；胡牌清空（胡不可撤销） ----
const UNDO_CAP = 60
function pushUndo() {
  S.undoStack.push(JSON.stringify({
    deck: S.deck, hand: S.hand, table: S.table, st: S.st,
    hu: S.hu, huLog: S.huLog, placedThisHand: S.placedThisHand,
    discarded: S.discarded, discardPile: S.discardPile,
    best: S.best, rngState: S.rngState, actionLog: S.actionLog,
  }))
  if (S.undoStack.length > UNDO_CAP) S.undoStack.shift()
}

// ---- 操作流水：记录放牌/弃牌/补牌/胡（撤销随快照回滚） ----
function logOp(type: ActionLogEntry['type'], text: string) {
  S.actionLog.push({ type, text })
}
function cardLabel(c: Card): string {
  if (c.kind === 'op') return c.wild ? '?✦' : c.o!
  return c.joker ? '✦' : rankLabel(c.v)
}

// 从牌库补牌至上限（回合开始/胡牌后共用）；新抽的牌标记 drawn（发牌动画，App 里逐张飞入）
function refillHand() {
  while (S.hand.length < HAND_SIZE && S.deck.length) {
    const c = S.deck.pop()!
    c.slot = freeSlot()     // 新牌坐进最左的空位
    c.drawn = true
    S.hand.push(c)
  }
  if (S.hand.some(c => c.drawn)) {
    fx.drawFrom = 'deck'
    fx.drawAt++
  }
}

export function place(cardIdx: number, ch: number | OpSymbol, opts: { deferHu?: boolean } = {}): boolean {
  const card = S.hand[cardIdx]
  if (!card) return false
  const next = card.kind === 'num' ? placeNum(S.st, ch as number) : placeOp(S.st, OP_TO_ENGINE[ch as OpSymbol])
  if (!next) return false

  pushUndo()
  S.st = next
  S.table.push({ card, ch })
  S.hand.splice(cardIdx, 1)
  S.placedThisHand++
  logOp('place', `出 ${card.kind === 'op' ? String(ch) : rankLabel(ch as number)}，总值 ${val(S.st)}`)
  saveGame()
  const hu = S.st.last === 'n' && val(S.st) === TARGET
  if (hu && !opts.deferHu) doHu()     // UI 传 deferHu：先播飞牌动画，再手动 doHu 结算
  return hu
  // 中途手牌暂时无牌可放不算死局——点「补牌」换牌后才有定论
}

export function doHu() {
  // 记录本胡算式（桌面马上要清空）
  const exprText = S.table.map(t => t.card.kind === 'op' ? String(t.ch) : rankLabel(t.ch as number)).join(' ')
  S.huLog.push({ expr: exprText })

  // 桌牌洗回牌库
  const rng = makeRng(S.rngState)
  for (const t of S.table) S.deck.push(t.card)
  shuffle(S.deck, rng)
  S.table = []
  S.st = freshState()
  S.hu++
  // 胡即定局：清撤销栈（不可撤到胡前）、重置连续出牌数；不自动补牌，由玩家点「补牌」
  logOp('hu', `胡 ${exprText}`)
  S.placedThisHand = 0
  S.undoStack = []
  if (S.hu > S.best) { S.best = S.hu; store.set('h1024.best', String(S.best)) }
  fx.burstAt++
  saveGame()
  upsertSave()
}

// 补牌：从牌库补满手牌（手牌已满或牌库空则不动，返回 false 供 UI 轻提示）
export function drawToFull(): boolean {
  if (S.hand.length >= HAND_SIZE || !S.deck.length) return false
  pushUndo()
  const before = S.hand.length
  refillHand()
  logOp('draw', `补牌 ${S.hand.length - before} 张`)
  saveGame()
  return true
}

// 撤销上一次操作（出牌/弃牌/补牌皆可回滚；胡后栈已清，胡不可撤）
export function undo() {
  const snap = S.undoStack.pop()
  if (!snap) return
  const d = JSON.parse(snap)
  const handWasEmpty = S.hand.length === 0            // 撤的是弃牌 → 牌从弃牌堆飞回
  const drawUndo = d.hand.length < S.hand.length && d.deck.length > S.deck.length  // 撤的是补牌 → 牌从手牌飞回牌库
  const placeUndo = d.table.length < S.table.length   // 撤的是出牌 → 桌尾 token 飞回手牌
  if (drawUndo) {
    // 渲染前记下要飞走的牌的座位（watcher 在 DOM 更新前触发，能拿到旧元素做克隆飞行）
    const snapSlots = new Set(d.hand.map((c: Card) => c.slot))
    fx.returnSlots = S.hand.filter(c => !snapSlots.has(c.slot)).map(c => c.slot!)
    fx.returnAt++
  }
  if (placeUndo) {
    // 回到手牌的那张牌的座位（watcher 渲染前触发，桌面旧 token 还在，可克隆飞行）
    const curSlots = new Set(S.hand.map(c => c.slot))
    const back = d.hand.find((c: Card) => !curSlots.has(c.slot))
    fx.undoPlaceSlot = back?.slot ?? 0
    fx.undoPlaceAt++
  }
  Object.assign(S, d)
  S.hand.forEach(c => { if (c.drawn) delete c.drawn })
  if (handWasEmpty && S.hand.length) {
    S.hand.forEach(c => { c.drawn = true })
    fx.drawFrom = 'discard'
    fx.drawAt++
  }
  saveGame()
}

// 弃牌实际执行：当前手牌移出本局（不洗回）。不自动补牌，由玩家点「补牌」手动补
export function doDiscard() {
  if (!S.hand.length) return
  pushUndo()
  const labels = S.hand.map(cardLabel).join(' ')
  S.discarded += S.hand.length
  S.discardPile.push(...S.hand)
  S.hand = []
  logOp('discard', `弃牌：${labels}`)
  saveGame()
}

let gidSeq = 0
export function newGame(seed?: number) {
  upsertSave(true)   // 上一局的最终存档落账（seed 0 的幽灵局自动跳过）
  // 局 ID：时间戳 + 序号（防同毫秒开局撞号，重来本局同 seed 也不会误覆盖历史）
  S.gid = Date.now() * 1000 + (++gidSeq % 1000)
  // 存档名：开局那一刻生成「第 N 局」，终身不变（计数器持久化，跨会话累加）
  const nameSeq = (Number(store.get('h1024.nameseq')) || 0) + 1
  store.set('h1024.nameseq', String(nameSeq))
  S.name = `第 ${nameSeq} 局`
  // 种子优先级：显式传入 > URL ?seed=（每局固定，方便测试）> 随机
  S.seed = seed ?? URL_SEED ?? Math.floor(Math.random() * 2 ** 31)
  S.rngState = { a: S.seed | 0 }
  S.deck = shuffle(buildDeck(), makeRng(S.rngState))
  S.hand = []
  refillHand()   // 开局发牌也走统一路径（触发飞牌动画）
  S.table = []
  S.st = freshState()
  S.hu = 0
  S.huLog = []
  S.actionLog = []
  S.placedThisHand = 0
  S.undoStack = []
  S.discarded = 0
  S.discardPile = []
  saveGame()
  upsertSave()
}
