#!/usr/bin/env node
// 《胡1024》D1：逻辑原型 + 模拟器 v5（出牌张数不限 + 起手＝上限，无弃牌/拆桌）
// 用法: node sim.mjs [games] [seed] [handSize]
//
// 规则（v5）：
//   回合 = ① 出牌（必须，至少 1 张，张数不限）→ ② 补牌至手牌上限（= 起手张数）
//   不设弃牌、不设拆桌；手中无合法可放 → 本局结束（只能重开）
//   AI：有完整成胡计划则一回合内连走到底；否则走「伤害控制」只出一小步（别烧牌）

const TARGET = 1024;

const CFG = {
  games: Number(process.argv[2] ?? 500),
  seed: Number(process.argv[3] ?? 20261022),
  handSize: Number(process.argv[4] ?? 6), // 起手张数 = 手牌上限（同一个参数）
  solveDepth: 10,       // 求解器最多规划步数（每步 1~2 张牌）
  solveNodes: 30000,    // 单次求解节点预算
  gameNodes: 400000,    // 每局求解节点总预算
  solveRetryGap: 2,     // 无计划时每隔几回合重试求解
  feasChecks: 6,        // 伤害控制时逐个候选做可行性检查的个数
  feasNodes: 1500,      // 单次可行性检查节点预算
  strat: process.env.SIM_STRAT ?? 'solver', // solver | p2（人类式 2 的幂乘积打法）
  maxTurns: 300,
};

// ---------- RNG ----------
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------- 牌组（108 张）----------
// k: 'n' 数字 | 'J' 王(数字万能) | 'o' 运算符 | 'W' 任意运算符
function buildDeck() {
  const d = [];
  for (let v = 1; v <= 13; v++) for (let s = 0; s < 4; s++) d.push({ k: 'n', v });
  d.push({ k: 'J' }, { k: 'J' });
  for (let i = 0; i < 13; i++) for (const o of ['+', '-', '*', '/']) d.push({ k: 'o', o });
  d.push({ k: 'W' }, { k: 'W' });
  // 实验用：给 1/2/4/8（乘积路径的唯一可用因子）加牌
  const extra = Number(process.env.SIM_EXTRA_SMALL ?? 0);
  for (let i = 0; i < extra; i++) for (const v of [1, 2, 4, 8]) d.push({ k: 'n', v });
  return d; // 默认 52 + 2 + 52 + 2 = 108
}

function shuffle(a, rnd) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = (rnd() * (i + 1)) | 0;
    [a[i], a[j]] = [a[j], a[i]];
  }
}

// ---------- 引擎状态（乘积项之和，增量求值，全规则）----------
const freshState = () => ({ total: 0, sign: 1, curV: null, last: null, lastOp: null });
const val = s => s.total + (s.curV === null ? 0 : s.sign * s.curV);

function placeNum(s, n) {
  if (s.last === 'n') return null;
  if (s.last === null) return { total: 0, sign: 1, curV: n, last: 'n', lastOp: null };
  if (s.lastOp === '*') return { ...s, curV: s.curV * n, last: 'n', lastOp: null };
  if (s.lastOp === '/') {
    if (s.curV % n !== 0) return null; // 除不尽，不合法
    return { ...s, curV: s.curV / n, last: 'n', lastOp: null };
  }
  return { ...s, curV: n, last: 'n', lastOp: null }; // '+'/'-' 后开新项
}

function placeOp(s, o) {
  if (s.last !== 'n') return null;
  if (o === '+') return { total: s.total + s.sign * s.curV, sign: 1, curV: null, last: 'o', lastOp: '+' };
  if (o === '-') return { total: s.total + s.sign * s.curV, sign: -1, curV: null, last: 'o', lastOp: '-' };
  return { ...s, last: 'o', lastOp: o }; // '*' '/' 不提交
}

// ---------- 合法放牌枚举 ----------
function legalPlays(s, hand) {
  const out = [];
  if (s.last !== 'n') { // 需要数字
    for (let i = 0; i < hand.length; i++) {
      const c = hand[i];
      if (c.k === 'n') { const st = placeNum(s, c.v); if (st) out.push({ ci: i, ch: c.v, st }); }
      else if (c.k === 'J') for (let v = 1; v <= 13; v++) out.push({ ci: i, ch: v, st: placeNum(s, v) });
    }
  } else { // 需要运算符
    for (let i = 0; i < hand.length; i++) {
      const c = hand[i];
      if (c.k === 'o') out.push({ ci: i, ch: c.o, st: placeOp(s, c.o) });
      else if (c.k === 'W') for (const o of ['+', '-', '*', '/']) out.push({ ci: i, ch: o, st: placeOp(s, o) });
    }
  }
  return out.filter(p => p.st);
}

// ---------- 求解器（正向路径：仅 '+' 与 '×'，王可作任意数字）----------
// 步骤 = {op:null|'*'|'+', num:n}；返回步骤数组（按序执行即成胡），无解返回 null
function solve(s0, hand, budget = { n: 0 }, nodeLimit = CFG.solveNodes) {
  if (s0.sign !== 1 || s0.lastOp === '-' || s0.lastOp === '/') return null;

  const num = Array(14).fill(0);
  let jokers = 0, plus = 0, times = 0;
  for (const c of hand) {
    if (c.k === 'n') num[c.v]++;
    else if (c.k === 'J') jokers++;
    else if (c.k === 'o') { if (c.o === '+') plus++; else if (c.o === '*') times++; }
  }

  let nodes = 0;
  const memo = new Set();
  const takeNum = n => {
    if (num[n] > 0) { num[n]--; return false; }
    if (jokers > 0) { jokers--; return true; }
    return null;
  };
  const giveNum = (n, uj) => { if (uj) jokers++; else num[n]++; };

  function dfs(total, curV, tail, lastOp, depth, path) {
    if (++nodes > nodeLimit || ++budget.n > CFG.gameNodes) throw 'budget';
    const v = total + (curV ?? 0);
    if (v === TARGET && tail === 'n') return true;
    if (v >= TARGET || depth <= 0) return false;
    const key = `${total}|${curV}|${tail}${lastOp ?? ''}|${jokers},${plus},${times}|${num.join('')}`;
    if (memo.has(key)) return false;

    if (tail === 'n') {
      if (times > 0) { // [×, m] 大乘数优先，线更短
        for (let m = 13; m >= 2; m--) {
          if (total + curV * m > TARGET) continue;
          const uj = takeNum(m);
          if (uj === null) continue;
          times--;
          path.push({ op: '*', num: m });
          if (dfs(total, curV * m, 'n', null, depth - 1, path)) return true;
          path.pop(); times++; giveNum(m, uj);
        }
      }
      if (plus > 0) { // [+, n]（n≥2，+1 填缝路径放弃以换速度）
        for (let n = 13; n >= 2; n--) {
          if (total + curV + n > TARGET) continue;
          const uj = takeNum(n);
          if (uj === null) continue;
          plus--;
          path.push({ op: '+', num: n });
          if (dfs(total + curV, n, 'n', null, depth - 1, path)) return true;
          path.pop(); plus++; giveNum(n, uj);
        }
      }
    } else { // 尾为运算符/空：放数字
      for (let n = 13; n >= 1; n--) {
        const nv = lastOp === '*' ? curV * n : n;
        if (total + nv > TARGET) continue;
        const uj = takeNum(n);
        if (uj === null) continue;
        path.push({ op: null, num: n });
        if (dfs(total, nv, 'n', null, depth - 1, path)) return true;
        path.pop(); giveNum(n, uj);
      }
    }
    memo.add(key);
    return false;
  }

  try {
    const path = [];
    const ok = dfs(s0.total, s0.curV, s0.last === 'n' ? 'n' : 'o', s0.lastOp, CFG.solveDepth, path);
    return ok ? path : null;
  } catch {
    return null;
  }
}

// ---------- 伤害控制（必须出牌但无成胡计划时）----------
// 先按「离最近的 2 的幂」排序候选出牌，再逐个做小预算可行性检查：
// 放完之后还能接上完整成胡计划的，才选它——避免一张烂牌废掉整局。
function chooseFallback(s, hand, budget) {
  const firsts = legalPlays(s, hand);
  if (!firsts.length) return null;
  const isHu = st => st.last === 'n' && val(st) === TARGET;
  const hu1 = firsts.find(f => isHu(f.st));
  if (hu1) return { hu: true, plays: [hu1] };

  const POW2 = [1, 2, 4, 8, 16, 32, 64, 128, 256, 512];
  const sc = st => {
    const v = val(st);
    if (v > TARGET) return 5000 + (v - TARGET); // 越界几乎必死
    let dp = Infinity;
    for (const p of POW2) dp = Math.min(dp, Math.abs(v - p));
    // 两套估值取小：贴近 1024（和式路径）与贴近 2 的幂（乘积路径）都要照顾
    return Math.min(Math.abs(v - TARGET), dp * 1000 - Math.min(v, 512) * 0.1);
  };

  const cands = [];
  for (const f of firsts) {
    const rest = hand.filter((_, i) => i !== f.ci);
    cands.push({ plays: [f], st: f.st, handAfter: rest });
    for (const sec of legalPlays(f.st, rest)) {
      if (isHu(sec.st)) return { hu: true, plays: [f, sec] };
      cands.push({ plays: [f, sec], st: sec.st, handAfter: rest.filter((_, i) => i !== sec.ci) });
    }
  }
  cands.sort((a, b) => sc(a.st) - sc(b.st));

  for (const c of cands.slice(0, CFG.feasChecks)) {
    if (sc(c.st) >= 9000) break; // 越界候选不必再试
    const plan = solve(c.st, c.handAfter, budget, CFG.feasNodes);
    if (plan && plan.length) return { hu: false, plays: c.plays, plan };
  }
  return { hu: false, plays: cands[0].plays };
}

// ---------- 牌局 ----------
const DBG = process.env.SIM_DEBUG === '1';
function runGame(rnd, idx = -1) {
  const deck = buildDeck();
  shuffle(deck, rnd);
  const g = {
    deck, hand: [], st: freshState(), tableCards: [],
    huCount: 0, turn: 0, plan: null, lastSolve: -99, endReason: null,
    budget: { n: 0 },
    st_: { huSizes: [], tianHu: 0, doubleJokerHu: 0, wildOpHu: 0, firstHuTurn: null, noPlanTurns: 0 },
  };
  for (let i = 0; i < CFG.handSize; i++) g.hand.push(deck.pop());

  const doHu = cardsThisTurn => {
    g.st_.huSizes.push(g.tableCards.length);
    const jokers = g.tableCards.filter(e => e.card.k === 'J').length;
    if (jokers === 2) g.st_.doubleJokerHu++;
    if (g.tableCards.some(e => e.card.k === 'W')) g.st_.wildOpHu++;
    if (cardsThisTurn >= 4) g.st_.tianHu++; // 天胡：单回合内连续 ≥4 张收尾
    if (g.st_.firstHuTurn === null) g.st_.firstHuTurn = g.turn;
    for (const e of g.tableCards) g.deck.push(e.card);
    shuffle(g.deck, rnd);
    g.tableCards = [];
    g.st = freshState();
    g.huCount++;
    g.plan = null;
  };
  const takeNumCard = n => {
    let i = g.hand.findIndex(c => c.k === 'n' && c.v === n);
    if (i < 0) i = g.hand.findIndex(c => c.k === 'J');
    return i;
  };
  const takeOpCard = o => {
    let i = g.hand.findIndex(c => c.k === 'o' && c.o === o);
    if (i < 0) i = g.hand.findIndex(c => c.k === 'W');
    return i;
  };
  const playCard = (i, ch) => {
    const card = g.hand[i];
    g.st = card.k === 'n' || card.k === 'J' ? placeNum(g.st, ch) : placeOp(g.st, ch);
    g.tableCards.push({ card, ch });
    g.hand.splice(i, 1);
  };
  const huNow = () => g.st.last === 'n' && val(g.st) === TARGET;

  // 执行一个求解步骤（1~2 张）；返回是否成功
  // 注意：先校验两张牌都在手，再逐张现取索引（放牌会让索引前移）
  const execStep = step => {
    if (step.op !== null && takeOpCard(step.op) < 0) return false;
    if (takeNumCard(step.num) < 0) return false;
    if (step.op !== null) playCard(takeOpCard(step.op), step.op);
    playCard(takeNumCard(step.num), step.num);
    return true;
  };

  // ---------- 「人类式」策略：死磕 2 的幂乘积 ----------
  // 1024 = 2^10，最大可用因子 13 → 因子只能取 2/4/8；缺牌时用 ×1（或 +n −n）顶住换牌。
  // 只衡量「规则本身能不能玩」，不代表最优解。
  const hasNum = n => g.hand.some(c => (c.k === 'n' && c.v === n) || c.k === 'J');
  const hasOp = o => g.hand.some(c => (c.k === 'o' && c.o === o) || c.k === 'W');
  const putNum = n => { const i = takeNumCard(n); if (i < 0) return false; playCard(i, n); return true; };
  const putOp = o => { const i = takeOpCard(o); if (i < 0) return false; playCard(i, o); return true; };

  const p2Turn = () => {
    let n = 0;
    while (n < CFG.handSize) {
      if (huNow()) return { n, hu: true };
      const v = val(g.st);
      if (v <= 0) { // 空桌：用 8/4/2 起头
        const f = [8, 4, 2, 1].find(x => hasNum(x));
        if (f === undefined || !putNum(f)) break;
        n++; continue;
      }
      if (TARGET % v !== 0) break; // 值已不可挽回，本策略放弃
      const R = TARGET / v;
      if (R === 1) break; // 值已是 1024 但尾不是数字（不可能出现在乘积路径里）
      const f = [8, 4, 2].find(x => R % x === 0 && hasNum(x) && hasOp('*'));
      if (f !== undefined) { if (!putOp('*') || !putNum(f)) break; n += 2; continue; }
      // 缺因子：×1 顶住（换 2 张牌，值不变）
      if (hasNum(1) && hasOp('*')) { if (!putOp('*') || !putNum(1)) break; n += 2; continue; }
      // 再退一步：+n −n（换 4 张牌，值不变）
      const pair = g.hand.filter(c => c.k === 'n').map(c => c.v).find(x => g.hand.filter(c => c.k === 'n' && c.v === x).length >= 2);
      if (pair !== undefined && hasOp('+') && hasOp('-')) {
        if (!putOp('+') || !putNum(pair) || !putOp('-') || !putNum(pair)) break;
        n += 4; continue;
      }
      break;
    }
    return { n, hu: huNow() };
  };

  // 出牌张数不限：一回合内把整条计划连走到底（成胡即停）
  const runPlan = () => {
    let n = 0;
    while (g.plan && g.plan.length) {
      const step = g.plan[0];
      if (!execStep(step)) { g.plan = null; break; }
      n += step.op !== null ? 2 : 1;
      g.plan.shift();
      if (huNow()) return { n, hu: true };
    }
    return { n, hu: false };
  };

  while (g.turn < CFG.maxTurns) {
    g.turn++;
    let placed = 0, hu = false;

    if (CFG.strat === 'p2') { // 「人类式」打法：只走 2 的幂乘积 + 中性顶牌
      const r2 = p2Turn();
      placed = r2.n; hu = r2.hu;
      if (!placed && !hu) { g.endReason = 'stuck'; } // 连顶牌都拿不出
      if (DBG && idx === 0) {
        const nums = g.hand.filter(c => c.k === 'n').map(c => c.v).join(',');
        const ops = g.hand.filter(c => c.k === 'o').map(c => c.o).join('');
        console.log(`  P2@T${g.turn} 值${val(g.st)} 手[数:${nums} 符:${ops}] 出${placed}张`);
      }
      if (g.endReason) break;
    } else {
    // 1) 已有计划 → 一回合内连走到底
    let r = runPlan();
    placed += r.n; hu = r.hu;

    if (!placed && !hu) { // 2) 求解（节流）→ 仍无计划 → 伤害控制
      if (g.turn - g.lastSolve >= CFG.solveRetryGap) {
        g.lastSolve = g.turn;
        g.plan = solve(g.st, g.hand, g.budget);
        if (Array.isArray(g.plan) && g.plan.length === 0) g.plan = null;
        if (DBG && idx === 0) {
          const n = g.hand.filter(c => c.k === 'n').map(c => c.v).sort((a, b) => a - b).join(',');
          const ops = g.hand.filter(c => c.k === 'o').map(c => c.o).join('');
          console.log(`  solve@T${g.turn} 值${val(g.st)} 尾${g.st.last}${g.st.lastOp ?? ''} 手[${n}|${ops}] → ${g.plan ? '计划' + g.plan.length + '步' : '无解'}`);
        }
      }
      r = runPlan();
      placed += r.n; hu = r.hu;

      if (!placed && !hu) { // 无计划：伤害控制只出一步，别把好牌烧进桌面
        const mv = chooseFallback(g.st, g.hand, g.budget);
        if (!mv) {
          if (DBG && idx === 0) {
            const nums = g.hand.filter(c => c.k === 'n').map(c => c.v).join(',');
            const jok = g.hand.filter(c => c.k === 'J').length;
            const ops = g.hand.filter(c => c.k === 'o').map(c => c.o).join('');
            console.log(`  DEAD@T${g.turn} 值${val(g.st)} 尾${g.st.last}${g.st.lastOp ?? ''} 手[数:${nums} 王:${jok} 符:${ops}] 桌${g.tableCards.length}`);
          }
          g.endReason = 'deadlock'; break; // 无合法可放 → 只能重开
        }
        for (const p of mv.plays) { playCard(p.ci, p.ch); placed++; }
        hu = huNow();
        g.st_.noPlanTurns++;
        if (!hu && mv.plan) { // 这一步之后接上的计划，本回合直接走完
          g.plan = mv.plan;
          r = runPlan();
          placed += r.n; hu = r.hu;
        }
      }
    }
    }

    if (hu) doHu(placed);

    if (DBG && idx === 0) {
      const nums = g.hand.filter(c => c.k === 'n' || c.k === 'J').length;
      console.log(`T${g.turn} 出${placed}张 桌牌${g.tableCards.length} 值${val(g.st)} 尾${g.st.last} 手${g.hand.length}(数${nums}/符${g.hand.length - nums}) 库${g.deck.length}${hu ? ' 胡!' : ''}`);
    }

    // ---- 补牌至上限（= 起手张数）----
    while (g.hand.length < CFG.handSize && g.deck.length) g.hand.push(g.deck.pop());
  }
  if (!g.endReason) g.endReason = g.turn >= CFG.maxTurns ? 'cap' : 'normal';
  return g;
}

// ---------- 自测 ----------
function selfTest() {
  let fail = 0;
  const seq = (tokens, expect, name) => {
    let s = freshState();
    for (const t of tokens) {
      s = t === '+' || t === '-' || t === '*' || t === '/' ? placeOp(s, t) : placeNum(s, t);
      if (s === null) { console.error(`✗ ${name}: 放牌被拒`); fail++; return; }
    }
    if (val(s) !== expect) { console.error(`✗ ${name}: got ${val(s)}, want ${expect}`); fail++; }
  };
  seq([13, '*', 13, '*', 6, '+', 10], 1024, '13×13×6+10');
  seq([11, '*', 11, '*', 8, '+', 7, '*', 8], 1024, '11×11×8+7×8');
  seq([8, '*', 8, '*', 4, '*', 4], 1024, '8×8×4×4');
  seq([13, '*', 3, '-', 5, '*', 2], 29, '负项 39-10');
  seq([64, '/', 2, '/', 4], 8, '连除 64/2/4');
  seq([3, '+', 5, '*', 2], 13, '优先级 3+5×2=13');
  let t = freshState(); t = placeNum(t, 7); t = placeOp(t, '/');
  if (placeNum(t, 3) !== null) { console.error('✗ 7÷3 应被拒绝'); fail++; }
  let w = freshState(); w = placeNum(w, 5);
  if (placeNum(w, 3) !== null) { console.error('✗ 数字后放数字应被拒'); fail++; }
  const hand = [];
  for (const v of [13, 13, 6, 10]) hand.push({ k: 'n', v });
  hand.push({ k: 'o', o: '*' }, { k: 'o', o: '*' }, { k: 'o', o: '+' });
  const sol = solve(freshState(), hand);
  if (!sol) { console.error('✗ 求解器: 13×13×6+10 牌型应可解'); fail++; }
  else {
    let s = freshState();
    for (const step of sol) {
      if (step.op !== null) s = placeOp(s, step.op);
      s = placeNum(s, step.num);
    }
    if (val(s) !== 1024) { console.error(`✗ 求解器解执行结果 ${val(s)} ≠ 1024`); fail++; }
  }
  if (fail === 0) console.log('self-test: 9/9 通过');
  return fail;
}

// ---------- 主流程 ----------
const fails = selfTest();
if (fails) process.exit(1);

const t0 = Date.now();
const games = [];
for (let i = 0; i < CFG.games; i++) games.push(runGame(mulberry32(CFG.seed + i), i));
const dt = ((Date.now() - t0) / 1000).toFixed(1);

const hus = games.map(g => g.huCount);
const avg = hus.reduce((a, b) => a + b, 0) / games.length;
const sorted = hus.slice().sort((a, b) => a - b);
const median = sorted[sorted.length >> 1];
const max = sorted[sorted.length - 1];
const zeroHu = games.filter(g => g.huCount === 0).length;
const ge3 = games.filter(g => g.huCount >= 3).length;
const ge5 = games.filter(g => g.huCount >= 5).length;
const firstHu = games.map(g => g.st_.firstHuTurn).filter(t => t !== null);
const avgFirstHu = firstHu.length ? (firstHu.reduce((a, b) => a + b, 0) / firstHu.length).toFixed(1) : '-';
const allHuSizes = games.flatMap(g => g.st_.huSizes);
const avgHuCards = allHuSizes.length ? (allHuSizes.reduce((a, b) => a + b, 0) / allHuSizes.length).toFixed(2) : '-';
const naked = allHuSizes.filter(n => n <= 7).length;
const tian = games.reduce((a, g) => a + g.st_.tianHu, 0);
const dj = games.reduce((a, g) => a + g.st_.doubleJokerHu, 0);
const wo = games.reduce((a, g) => a + g.st_.wildOpHu, 0);
const avgTurns = (games.reduce((a, g) => a + g.turn, 0) / games.length).toFixed(1);
const noPlan = (games.reduce((a, g) => a + g.st_.noPlanTurns, 0) / games.length).toFixed(1);
const reasons = {};
for (const g of games) reasons[g.endReason] = (reasons[g.endReason] || 0) + 1;

const dist = {};
for (const h of hus) dist[Math.min(h, 20)] = (dist[Math.min(h, 20)] || 0) + 1;

console.log(`\n=== 《胡1024》模拟报告（v5 出牌张数不限 + 起手＝上限）===`);
console.log(`配置: ${CFG.games} 局 | 牌组 108 张(数字位54:运算符54) | 起手=上限 ${CFG.handSize} | seed=${CFG.seed} | ${dt}s`);
console.log(`平均胡数/局: ${avg.toFixed(2)}   中位数: ${median}   最大: ${max}`);
console.log(`胡数分布: ${Object.keys(dist).sort((a, b) => a - b).map(k => `${k === '20' ? '20+' : k}胡:${(dist[k] / games.length * 100).toFixed(1)}%`).join('  ')}`);
console.log(`0胡局: ${(zeroHu / games.length * 100).toFixed(1)}%   终局原因: ${JSON.stringify(reasons)}`);
console.log(`达标线(≥3胡): ${(ge3 / games.length * 100).toFixed(1)}%   高手线(≥5胡): ${(ge5 / games.length * 100).toFixed(1)}%`);
console.log(`首次胡平均回合: ${avgFirstHu}   平均成胡牌数: ${avgHuCards}   裸胡(≤7张)占比: ${(naked / allHuSizes.length * 100).toFixed(1)}%`);
console.log(`天胡次数: ${tian}   王炸次数: ${dj}   任意运算符参与: ${wo}`);
console.log(`平均回合数: ${avgTurns}   无计划出牌/局: ${noPlan}`);
const verdict = avg >= 3 ? '✓ 配比成立，可进 UI 阶段' : avg >= 1 ? '△ 偏难，调上限/起手' : '✗ 机制性问题，回炉议规则';
console.log(`结论: ${verdict}\n`);
