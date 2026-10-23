// 死局频率统计：三种出牌策略下，「真死局」的发生率与形态
import fs from 'node:fs';

const html = fs.readFileSync(new URL('../../index.html', import.meta.url), 'utf8');
const code = html.match(/<script>([\s\S]*?)<\/script>/)[1];

function makeEl() {
  const el = {
    textContent: '', innerHTML: '', className: '', disabled: false, scrollTop: 0, scrollHeight: 0,
    style: {}, children: [], onclick: null, dataset: {},
    classList: { _s: new Set(), add(){}, remove(){}, toggle(){}, contains(){ return false; } },
    insertAdjacentHTML() {}, appendChild(c) { this.children.push(c); },
  };
  return el;
}
const cache = new Map();
const document = {
  getElementById(id) { if (!cache.has(id)) cache.set(id, makeEl()); return cache.get(id); },
  createElement() { return makeEl(); },
  querySelectorAll() { return []; },
};
const store = new Map();
const localStorage = { getItem: k => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, v) };

const harness = `
globalThis.__api = { S, place, endTurn, newGame, val, TARGET, HAND_SIZE, freshState, placeNum, placeOp, buildDeck, shuffle };
`;
new Function('document', 'localStorage', 'window', code + harness)(document, localStorage, {});
const A = globalThis.__api;

// 枚举当前所有合法落子
function moves(S) {
  const out = [];
  for (let i = 0; i < S.hand.length; i++) {
    const c = S.hand[i];
    if (S.st.last !== 'n') { // 要数字
      if (c.kind !== 'num') continue;
      const vals = c.joker ? [1,2,3,4,5,6,7,8,9,10,11,12,13] : [c.v];
      for (const v of vals) { const st = A.placeNum(S.st, v); if (st) out.push({ i, ch: v, st, op: null }); }
    } else {                 // 要运算符
      if (c.kind !== 'op') continue;
      const ops = c.wild ? ['+', '-', '×', '÷'] : [c.o];
      for (const o of ops) {
        const eng = o === '×' ? '*' : o === '÷' ? '/' : o;
        const st = A.placeOp(S.st, eng);
        if (st) out.push({ i, ch: o, st, op: o });
      }
    }
  }
  return out;
}
// 手里（不含将放的这张运算符）有没有能整除 curV 的数字
function hasDivisor(S) {
  const cv = S.st.curV ?? 0;
  return S.hand.some(c => c.kind === 'num' && (c.joker || cv % c.v === 0));
}

const POLICIES = {
  random(mv, S) { return mv[(Math.random() * mv.length) | 0]; },
  noDiv(mv) { const f = mv.filter(m => m.op !== '÷'); return (f.length ? f : mv)[0]; }, // 永不放 ÷（取第一个）
  careful(mv, S) {
    let best = null, bs = -1e9;
    for (const m of mv) {
      const v = A.val(m.st);
      let s = 0;
      if (v > A.TARGET) s -= 10000;                                  // 越界几乎必死
      else s += (A.TARGET % v === 0 ? 500 : 0) + v;                  // 贴 2 的幂路径
      if (m.op === '÷' && !hasDivisor(S)) s -= 800;                  // ÷ 后没除数 = 埋雷
      if (s > bs) { bs = s; best = m; }
    }
    return best;
  },
  // 谨慎玩家：每回合只放 1 张（由 run 里的 onePerTurn 控制），其余同 careful
};

const ONE_PER_TURN = new Set(['careful']);

function run(policyName, games) {
  const pick = POLICIES[policyName];
  let stuck = 0, turnsSum = 0, huSum = 0, maxT = 0;
  const tails = { '÷': 0, '要运算符': 0, '要数字': 0 };
  for (let g = 0; g < games; g++) {
    A.newGame();
    let t = 0;
    while (!A.S.stuck && t < 500) {
      t++;
      let guard = 0;
      while (!A.S.stuck && guard++ < 15) {
        const mv = moves(A.S);
        if (!mv.length) break;
        const m = pick(mv, A.S);
        A.place(m.i, m.ch);
        if (A.val(A.S.st) === A.TARGET && A.S.st.last === 'n') break; // 胡
        if (ONE_PER_TURN.has(policyName)) break;                      // 谨慎：一回合只放 1 张
      }
      if (A.S.stuck || A.S.placedThisTurn === 0) break;
      A.endTurn();
    }
    if (A.S.stuck) {
      stuck++;
      turnsSum += t; maxT = Math.max(maxT, t);
      if (A.S.st.lastOp === '/') tails['÷']++;
      else if (A.S.st.last === 'n') tails['要运算符']++;
      else tails['要数字']++;
    }
    huSum += A.S.hu;
  }
  console.log(`${policyName.padEnd(8)} 死局率 ${(stuck / games * 100).toFixed(1).padStart(5)}% | 死局均回合 ${(turnsSum / Math.max(stuck, 1)).toFixed(1).padStart(5)} | 均 ${(huSum / games).toFixed(2)} 胡 | 最长 ${maxT} 回合 | 死局形态`, tails);
}

const G = 1000;
for (const p of Object.keys(POLICIES)) run(p, G);

// 结构概率：桌尾挂 ÷ 且当前项为 cv 时，随机 6 张补牌接不上的概率
console.log('\n桌尾挂 ÷ 时，6 张补牌无除数的概率（超几何，整副牌剩 102 张）:');
for (const cv of [2, 3, 4, 5, 6, 8, 12]) {
  const divCount = [1, 2, 3, 4, 6, 8, 12].filter(d => cv % d === 0).length * 4 + 2; // 可整除的数字牌 + 2 王
  const n = 102, k = divCount;
  let miss = 1;
  for (let i = 0; i < 6; i++) miss *= (n - k - i) / (n - i);
  console.log(`  当前项 ${String(cv).padStart(2)}：可跟的牌 ${String(k).padStart(2)} 张 → 补 6 张全 miss ${(miss * 100).toFixed(0)}%`);
}
