// ============ 求值引擎（与 legacy/sim/sim.mjs 同一套规则） ============
import type { EngineOp, EngineState } from './types'

export const TARGET = 1024
export const HAND_SIZE = 6          // 起手张数 = 手牌上限

export const freshState = (): EngineState => ({ total: 0, sign: 1, curV: null, last: null, lastOp: null })

export const val = (s: EngineState) => s.total + (s.curV === null ? 0 : s.sign * s.curV)

export function placeNum(s: EngineState, n: number): EngineState | null {
  if (s.last === 'n') return null
  if (s.last === null) return { total: 0, sign: 1, curV: n, last: 'n', lastOp: null }
  if (s.lastOp === '*') return { ...s, curV: s.curV! * n, last: 'n', lastOp: null }
  if (s.lastOp === '/') {
    if (s.curV! % n !== 0) return null
    return { ...s, curV: s.curV! / n, last: 'n', lastOp: null }
  }
  return { ...s, curV: n, last: 'n', lastOp: null }
}

export function placeOp(s: EngineState, o: EngineOp): EngineState | null {
  if (s.last !== 'n') return null
  if (o === '+') return { total: s.total + s.sign * s.curV!, sign: 1, curV: null, last: 'o', lastOp: '+' }
  if (o === '-') return { total: s.total + s.sign * s.curV!, sign: -1, curV: null, last: 'o', lastOp: '-' }
  return { ...s, last: 'o', lastOp: o }
}
