// ============ 类型 ============
export type Suit = '♠' | '♥' | '♦' | '♣'
export type OpSymbol = '+' | '-' | '×' | '÷'
export type EngineOp = '+' | '-' | '*' | '/'

export interface NumCard {
  kind: 'num'
  v: number
  suit?: Suit
  joker?: boolean     // 王：万能数字
  slot?: number       // 手牌座位号 0~5
  drawn?: boolean     // UI 瞬态：本次补牌新抽的（飞入动画用，不参与逻辑）
}
export interface OpCard {
  kind: 'op'
  o?: OpSymbol
  suit?: Suit
  wild?: boolean      // 任意运算符
  slot?: number
  drawn?: boolean
}
export type Card = NumCard | OpCard

export interface TableToken { card: Card; ch: number | OpSymbol }

// 「乘积项之和」求值结构：total + sign * curV
export interface EngineState {
  total: number
  sign: number
  curV: number | null
  last: 'n' | 'o' | null
  lastOp: EngineOp | null
}

export interface HuRecord { expr: string; gains: string[] }
