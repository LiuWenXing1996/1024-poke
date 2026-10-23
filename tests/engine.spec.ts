import { describe, expect, it } from 'vitest'
import { HAND_SIZE, TARGET, freshState, placeNum, placeOp, val } from '../src/engine/engine'
import { buildDeck, rankLabel } from '../src/engine/cards'
import { makeRng, shuffle } from '../src/engine/rng'

describe('求值引擎', () => {
  it('8 × 8 × 4 × 4 = 1024（跨两回合的链式落子）', () => {
    let st = freshState()
    for (const step of [8, '*', 8, '*', 4, '*', 4]) {
      st = typeof step === 'number' ? placeNum(st, step)! : placeOp(st, step as '*' | '/')!
    }
    expect(val(st)).toBe(1024)
    expect(TARGET).toBe(1024)
  })

  it('除法只允许整除（最后乘积项）', () => {
    const s5 = { total: 0, sign: 1, curV: 5, last: 'o' as const, lastOp: '/' as const }
    expect(placeNum(s5, 2)).toBeNull()
    expect(placeNum(s5, 5)).not.toBeNull()
  })

  it('数字后必须接运算符，运算符后必须接数字', () => {
    const s = placeNum(freshState(), 8)!
    expect(placeNum(s, 3)).toBeNull()
    const s2 = placeOp(s, '+')!
    expect(placeOp(s2, '-')).toBeNull()
  })
})

describe('牌组', () => {
  it('108 张：52 数字 + 2 王 + 52 运算符 + 2 任意运算符', () => {
    const d = buildDeck()
    expect(d.length).toBe(108)
    expect(d.filter(c => c.kind === 'num').length).toBe(54)
    expect(d.filter(c => c.kind === 'num' && c.joker).length).toBe(2)
    expect(d.filter(c => c.kind === 'op').length).toBe(54)
    expect(d.filter(c => c.kind === 'op' && c.wild).length).toBe(2)
  })

  it('点数标签 A/J/Q/K', () => {
    expect(rankLabel(1)).toBe('A')
    expect(rankLabel(11)).toBe('J')
    expect(rankLabel(12)).toBe('Q')
    expect(rankLabel(13)).toBe('K')
    expect(rankLabel(8)).toBe('8')
  })
})

describe('种子随机', () => {
  it('同种子同序列，异种子异序列', () => {
    const a = makeRng({ a: 42 })
    const b = makeRng({ a: 42 })
    const c = makeRng({ a: 43 })
    const seqA = Array.from({ length: 5 }, () => a())
    const seqB = Array.from({ length: 5 }, () => b())
    const seqC = Array.from({ length: 5 }, () => c())
    expect(seqA).toEqual(seqB)
    expect(seqA).not.toEqual(seqC)
  })

  it('同种子洗牌结果一致，且不丢牌', () => {
    const d1 = shuffle(buildDeck(), makeRng({ a: 7 }))
    const d2 = shuffle(buildDeck(), makeRng({ a: 7 }))
    expect(d1.map(c => (c.kind === 'num' ? `n${c.joker ? 'W' : c.v}` : `o${c.wild ? 'W' : c.o}`)))
      .toEqual(d2.map(c => (c.kind === 'num' ? `n${c.joker ? 'W' : c.v}` : `o${c.wild ? 'W' : c.o}`)))
    expect(d1.length).toBe(108)
  })

  it('手牌上限常量', () => {
    expect(HAND_SIZE).toBe(6)
  })
})
