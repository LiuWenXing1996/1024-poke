// 完整对局流程测试（移植自 legacy/sim/ui-test.mjs 的 10 组断言 + 自动存档）
import { describe, expect, it } from 'vitest'
import { S, SAVE_KEY, loadHist, resumeGame, store } from '../src/game/state'
import { doDiscard, drawToFull, newGame, place, undo } from '../src/game/actions'
import { HAND_SIZE, freshState, placeNum, placeOp, val } from '../src/engine/engine'
import type { Card, OpSymbol } from '../src/engine/types'

const mk = (v: number): Card => ({ kind: 'num', v, suit: '♠' })
const mko = (o: OpSymbol): Card => ({ kind: 'op', o })

// 暴力穷举合法落子（与页面 placementFor 同源，但不复用其捷径）
function findMove(): { idx: number; ch: number | OpSymbol } | null {
  for (let i = 0; i < S.hand.length; i++) {
    const c = S.hand[i]
    if (c.kind === 'num') {
      const vals = c.joker ? [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13] : [c.v]
      for (const v of vals) if (placeNum(S.st, v)) return { idx: i, ch: v }
    } else {
      const ops: OpSymbol[] = c.wild ? ['+', '-', '×', '÷'] : [c.o!]
      for (const o of ops) {
        const eng = o === '×' ? '*' as const : o === '÷' ? '/' as const : o as '+' | '-'
        if (placeOp(S.st, eng)) return { idx: i, ch: o }
      }
    }
  }
  return null
}

function put(tok: number | OpSymbol) {
  const i = S.hand.findIndex(c =>
    typeof tok === 'number' ? (c.kind === 'num' && c.v === tok) : (c.kind === 'op' && c.o === tok))
  expect(i).toBeGreaterThanOrEqual(0)
  place(i, tok)
}

describe('对局流程', () => {
  it('1. 开局状态', () => {
    newGame()
    expect(S.hand.length).toBe(HAND_SIZE)
    expect(S.deck.length).toBe(108 - HAND_SIZE)
    expect(S.table.length).toBe(0)
  })

  it('2. 手牌上限：补牌不超上限', () => {
    const c = S.hand[0]
    place(0, c.kind === 'num' ? (c.joker ? 6 : c.v) : c.o!)
    drawToFull()
    expect(S.hand.length).toBeLessThanOrEqual(HAND_SIZE)
  })

  it('3. 满手牌补牌无效', () => {
    newGame()
    const before = S.hand.length
    expect(drawToFull()).toBe(false)   // 手牌已满 → 无操作
    expect(S.hand.length).toBe(before)
  })

  it('4. 完整对局：随机合法出牌 ×60 局，不变量守恒', () => {
    let huTotal = 0
    for (let gi = 0; gi < 60; gi++) {
      newGame()
      let guard = 0
      while (guard++ < 300) {
        const mv = findMove()
        if (mv) { place(mv.idx, mv.ch); continue }
        // 无合法出牌：满手先弃牌换血，再补牌；补不了 = 走投无路
        if (S.hand.length === HAND_SIZE) doDiscard()
        if (!drawToFull()) break
      }
      huTotal += S.hu
      expect(S.hand.length + S.table.length + S.deck.length + S.discarded).toBe(108)
      expect(S.hand.length).toBeLessThanOrEqual(HAND_SIZE)
      if (S.table.length && S.st.last === 'n') expect(val(S.st)).not.toBe(1024)
    }
    expect(S.best).toBeGreaterThanOrEqual(0)
  }, 15000)

  it('5. 成胡路径：8 × 8 × 4 × 4（补牌续凑，共 7 张）+ 胡牌记录 + 历史入账', () => {
    newGame()                      // 吸收 test 4 残留局
    newGame()                      // 拿到一个干净的新局（其入账在下一行被清掉）
    store.set('h1024.hist', '[]')  // 清空历史，从头验证入账（此后不再开局，直到打完）
    S.hand = [mk(8), mko('×'), mk(8), mko('×'), mk(4), mko('×')]
    S.table = []
    S.st = freshState()
    S.placedThisHand = 0
    const deckBefore = S.deck.length

    put(8); put('×'); put(8); put('×'); put(4); put('×')
    expect(val(S.st)).toBe(256)
    expect(S.table.length).toBe(6)
    drawToFull()
    S.hand.push(mk(4))
    put(4)
    expect(S.hu).toBe(1)
    expect(S.table.length).toBe(0)
    expect(S.deck.length).toBe(deckBefore - 6 + 7)
    expect(S.run.tianHu).toBe(1)   // 距上次胡连续出 7 张（≥4）→ 天胡
    expect(S.run.naked).toBe(1)    // 裸胡（≤7 张）
    expect(S.huLog.length).toBe(1)
    expect(S.huLog[0].expr).toBe('8 × 8 × 4 × 4')
    expect(S.huLog[0].gains.join('')).toBe('🥇 天胡🎯 裸胡')
    // 历史实时入账：当前局每步操作即 upsert 进历史，开新局时上一局已带最终数据躺在历史里
    newGame(42)
    const hist = loadHist()
    expect(hist.length).toBe(2)          // 刚打完的胡局（实时入账）+ 当前的空局
    expect(hist[0].hu).toBe(0)           // 当前局（新开，尚未操作）
    expect(hist[1].hu).toBe(1)           // 上一局实时入账：1 胡
    newGame(42)
    const hist2 = loadHist()
    expect(hist2.length).toBe(3)         // 新空局也实时入账
    expect(hist2[0].hu).toBe(0)
  })

  it('6. 除法整除校验', () => {
    const s5 = { total: 0, sign: 1, curV: 5, last: 'o' as const, lastOp: '/' as const }
    expect(placeNum(s5, 2)).toBeNull()
    expect(placeNum(s5, 5)).not.toBeNull()
  })

  it('7. 撤销：落子/弃牌皆可快照回滚，可一路撤到开局（胡除外）', () => {
    newGame(42)
    S.hand = [mk(8), mko('×'), mk(8), mko('×'), mk(4), mko('×')]
    S.table = []
    S.st = freshState()
    S.placedThisHand = 0
    S.undoStack = []
    put(8); put('×')
    expect(S.table.length).toBe(2)
    expect(S.undoStack.length).toBe(2)
    expect(S.hand.length).toBe(4)
    undo()
    expect(S.table.length).toBe(1)
    expect(val(S.st)).toBe(8)
    expect(S.hand.length).toBe(5)
    expect(S.hand.some(c => c.kind === 'op' && c.o === '×')).toBe(true)
    expect(S.placedThisHand).toBe(1)
    // 弃牌也可撤销
    doDiscard()
    expect(S.hand.length).toBe(0)
    undo()
    expect(S.hand.length).toBe(5)
    expect(S.discarded).toBe(0)
    // 无回合边界：可一路撤到开局
    undo()
    expect(S.table.length).toBe(0)
    expect(S.undoStack.length).toBe(0)
    undo()             // 栈空 → 空操作
    expect(S.table.length).toBe(0)
  })

  it('8. 种子：同种子同牌序', () => {
    const deal = () => S.hand.map(c => (c.kind === 'num' ? `n${c.joker ? 'W' : c.v}` : `o${c.wild ? 'W' : c.o}`)).join(',')
    newGame(42)
    const deal1 = deal()
    newGame(42)
    const deal2 = deal()
    newGame(43)
    const deal3 = deal()
    expect(deal1).toBe(deal2)
    expect(deal1).not.toBe(deal3)
    expect(S.seed).toBe(43)
    newGame(7)
    expect(S.deck.length).toBe(108 - HAND_SIZE)
  })

  it('9. 弃牌：全部手牌移出本局不洗回，不自动补牌（补牌按钮回满）', () => {
    newGame(11)
    const deckBefore = S.deck.length
    doDiscard()
    expect(S.discarded).toBe(6)
    expect(S.deck.length).toBe(deckBefore)        // 弃牌不动牌库（弃掉的牌移出本局）
    expect(S.hand.length).toBe(0)                 // 不自动补牌
    drawToFull()                                  // 手动点「补牌」
    expect(S.hand.length).toBe(HAND_SIZE)
    expect(S.deck.length).toBe(deckBefore - HAND_SIZE)
    undo()                                        // 补牌也可撤销
    expect(S.hand.length).toBe(0)
    expect(S.deck.length).toBe(deckBefore)
    drawToFull()
    expect(S.hand.length).toBe(HAND_SIZE)
    expect(S.deck.length).toBe(deckBefore - HAND_SIZE)
    expect(S.hand.length + S.table.length + S.deck.length + S.discarded).toBe(108)
    doDiscard()
    expect(S.discarded).toBe(12)
    expect(S.deck.length).toBe(deckBefore - HAND_SIZE)   // 弃牌依旧不动牌库
    // 牌库耗尽：连弃带补直到抽干
    let guard = 0
    while (S.deck.length > 0 && guard++ < 30) { doDiscard(); drawToFull() }
    expect(S.deck.length).toBe(0)
    expect(S.hand.length + S.table.length + S.deck.length + S.discarded).toBe(108)
  })

  it('10. 弃牌换血：弃牌后手动补牌，救场运算符到手', () => {
    newGame(13)
    S.table = [{ card: { kind: 'num', v: 2, suit: '♠' }, ch: 2 }] // 桌尾数字，要运算符
    S.st = { total: 0, sign: 1, curV: 2, last: 'n', lastOp: null }
    S.hand = [mk(3), mk(5)]                                       // 全数字，放不了
    S.deck = [mk(3), mk(7), mk(1), mk(12), mk(5), mk(9), mko('+')] // 牌堆顶（尾）是 '+'
    doDiscard()
    expect(S.hand.length).toBe(0)
    drawToFull()
    expect(S.hand.length).toBe(HAND_SIZE)
    expect(S.hand.some(c => c.kind === 'op')).toBe(true)
  })

  it('11. 自动存档：中断后恢复，随机流从断点接上', () => {
    newGame(7)
    const c0 = S.hand[0]
    place(0, c0.kind === 'num' ? (c0.joker ? 6 : c0.v) : c0.o!)   // 内部已 saveGame
    const savedHu = S.hu, savedSeed = S.seed, savedPlaced = S.placedThisHand
    const savedDeck = JSON.stringify(S.deck.map(c => (c.kind === 'num' ? `n${c.joker ? 'W' : c.v}` : `o${c.wild ? 'W' : c.o}`)))

    for (const k of Object.keys(S)) delete (S as unknown as Record<string, unknown>)[k]  // 模拟刷新：内存全丢
    expect(resumeGame()).toBe(true)
    expect(S.seed).toBe(savedSeed)
    expect(S.hu).toBe(savedHu)
    expect(S.placedThisHand).toBe(savedPlaced)
    expect(JSON.stringify(S.deck.map(c => (c.kind === 'num' ? `n${c.joker ? 'W' : c.v}` : `o${c.wild ? 'W' : c.o}`)))).toBe(savedDeck)

    // 恢复后的局继续推进到结束，牌数守恒（洗牌用恢复的 rngState）
    let guard = 0
    while (guard++ < 300) {
      const mv = findMove()
      if (mv) { place(mv.idx, mv.ch); continue }
      if (S.hand.length === HAND_SIZE) doDiscard()
      if (!drawToFull()) break
    }
    expect(S.hand.length + S.table.length + S.deck.length + S.discarded).toBe(108)

    // 无存档 → 恢复失败
    store.set(SAVE_KEY, '')
    expect(resumeGame()).toBe(false)
  })
})
