// ============ 牌组（108 张：52 数字 + 2 王 + 52 运算符 + 2 任意运算符） ============
import type { Card, OpSymbol, Suit } from './types'

export const SUITS: Suit[] = ['♠', '♥', '♦', '♣']
export const OPS: OpSymbol[] = ['+', '-', '×', '÷']
export const OP_TO_ENGINE: Record<OpSymbol, '+' | '-' | '*' | '/'> = { '+': '+', '-': '-', '×': '*', '÷': '/' }
const RANK_LABEL: Record<number, string> = { 1: 'A', 11: 'J', 12: 'Q', 13: 'K' }
export const rankLabel = (v: number) => RANK_LABEL[v] || String(v)

export function buildDeck(): Card[] {
  const d: Card[] = []
  for (let v = 1; v <= 13; v++) for (const s of SUITS) d.push({ kind: 'num', v, suit: s })
  d.push({ kind: 'num', v: 0, joker: true }, { kind: 'num', v: 0, joker: true })
  for (let i = 0; i < 13; i++) for (const o of OPS) d.push({ kind: 'op', o, suit: SUITS[i % 4] })
  d.push({ kind: 'op', o: '+', wild: true }, { kind: 'op', o: '+', wild: true })
  return d
}
