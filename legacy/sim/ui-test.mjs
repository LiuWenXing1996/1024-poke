// 无头测试：把 index.html 的脚本挂到 stub DOM 上跑完整局，验证状态机不崩
import fs from 'node:fs';

const html = fs.readFileSync(new URL('../../index.html', import.meta.url), 'utf8');
const code = html.match(/<script>([\s\S]*?)<\/script>/)[1];

function makeEl() {
  const el = {
    textContent: '', innerHTML: '', className: '', disabled: false, scrollTop: 0, scrollHeight: 0,
    style: {}, children: [], onclick: null, dataset: {},
    classList: { _s: new Set(), add(c){this._s.add(c);}, remove(c){this._s.delete(c);}, toggle(c,f){f?this._s.add(c):this._s.delete(c);}, contains(c){return this._s.has(c);} },
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
globalThis.__api = { S, place, endTurn, newGame, hasAnyMove, placementFor, val, TARGET, HAND_SIZE, freshState, placeNum, placeOp, undo, doDiscard, isStuck, loadHist, saveGame, resumeGame };
`;
new Function('document', 'localStorage', 'window', code + harness)(document, localStorage, {});

const A = globalThis.__api;
let fails = 0;
const ok = (cond, msg) => { if (!cond) { console.error('✗ ' + msg); fails++; } };

// ---- 1. 开局状态 ----
A.newGame();
ok(A.S.hand.length === A.HAND_SIZE, `起手 ${A.S.hand.length} 张，应为 ${A.HAND_SIZE}`);
ok(A.S.deck.length === 108 - A.HAND_SIZE, `牌库剩余 ${A.S.deck.length}，应为 ${108 - A.HAND_SIZE}`);
ok(A.S.table.length === 0, '牌桌应为空');

// ---- 2. 手牌上限：补牌不超上限 ----
A.place(0, A.S.hand[0].kind === 'num' ? (A.S.hand[0].joker ? 6 : A.S.hand[0].v) : A.S.hand[0].o);
A.endTurn();
ok(A.S.hand.length <= A.HAND_SIZE, `补牌后 ${A.S.hand.length} 张，超过上限`);

// ---- 3. 违规：一张没出不能结束出牌 ----
const before = A.S.hand.length;
A.endTurn(); // placedThisTurn === 0 → 应无操作
ok(A.S.hand.length === before, '未出牌却补了牌');

// ---- 4. 完整对局：随机合法出牌，直到结束 ----
// 暴力穷举合法落子（和页面 hasAnyMove 同源，但不复用其捷径）
function findMove() {
  for (let i = 0; i < A.S.hand.length; i++) {
    const c = A.S.hand[i];
    if (c.kind === 'num') {
      const vals = c.joker ? [1,2,3,4,5,6,7,8,9,10,11,12,13] : [c.v];
      for (const v of vals) if (A.placeNum(A.S.st, v)) return { idx: i, ch: v };
    } else {
      const ops = c.wild ? ['+', '-', '×', '÷'] : [c.o];
      for (const o of ops) {
        const eng = o === '×' ? '*' : o === '÷' ? '/' : o;
        if (A.placeOp(A.S.st, eng)) return { idx: i, ch: o };
      }
    }
  }
  return null;
}

let games = 0, huTotal = 0, ended = 0, maxTurns = 0;
for (let gi = 0; gi < 200; gi++) {
  A.newGame();
  let turns = 0;
  while (!A.isStuck() && turns < 400) {
    turns++;
    let guard = 0;
    while (!A.isStuck() && guard++ < 12) {
      const mv = findMove();
      if (!mv) break;
      A.place(mv.idx, mv.ch);
      if (A.isStuck()) break;
    }
    if (A.isStuck()) break;
    if (A.S.placedThisTurn === 0) break; // 无牌可放且无法推进（理论上是死局态）
    A.endTurn();
  }
  games++;
  huTotal += A.S.hu;
  if (A.isStuck()) ended++;
  maxTurns = Math.max(maxTurns, turns);
  // 不变量
  const totalCards = A.S.hand.length + A.S.table.length + A.S.deck.length;
  if (totalCards !== 108) { console.error(`✗ 第 ${gi} 局牌数 ${totalCards} ≠ 108`); fails++; }
  if (A.S.hand.length > A.HAND_SIZE) { console.error(`✗ 第 ${gi} 局手牌超限`); fails++; }
  if (A.S.table.length && A.S.st.last === 'n' && A.val(A.S.st) === A.TARGET) { console.error(`✗ 第 ${gi} 局成胡未结算`); fails++; }
}

console.log(`对局 ${games} 局 | 平均 ${(huTotal / games).toFixed(2)} 胡 | 结束局 ${ended} | 最长回合 ${maxTurns}`);
ok(ended === games, `有 ${games - ended} 局没走到结束状态`);
ok(A.S.best >= 0, 'best 异常');
// ---- 5. 成胡路径：8 × 8 × 4 × 4（跨两回合，共 7 张） ----
A.newGame();
const mk = (v) => ({ kind: 'num', v, suit: '♠' });
const mko = (o) => ({ kind: 'op', o });
A.S.hand = [mk(8), mko('×'), mk(8), mko('×'), mk(4), mko('×')];
A.S.table = []; A.S.st = A.freshState(); A.S.placedThisTurn = 0;
const deckBefore = A.S.deck.length;

function put(tok) {
  const i = A.S.hand.findIndex(c =>
    typeof tok === 'number' ? (c.kind === 'num' && c.v === tok) : (c.kind === 'op' && c.o === tok));
  if (i < 0) { console.error(`✗ 找不到牌 ${tok}`); fails++; return false; }
  A.place(i, tok);
  return true;
}
['8', '×'].forEach(() => {});
put(8); put('×'); put(8); put('×'); put(4); put('×');
ok(A.val(A.S.st) === 256, `中途值 ${A.val(A.S.st)}，应为 256`);
ok(A.S.table.length === 6, `桌面 ${A.S.table.length} 张，应为 6`);
A.endTurn();
A.S.hand.push(mk(4));
put(4);
ok(A.S.hu === 1, `胡数 ${A.S.hu}，应为 1`);
ok(A.S.table.length === 0, '胡后牌桌未清空');
ok(A.S.deck.length === deckBefore - 6 + 7, `胡后牌库 ${A.S.deck.length}，应为 ${deckBefore - 6 + 7}`);
ok(A.S.run.tianHu === 0, '收尾回合只出了 1 张，不该记天胡');
ok(A.S.run.naked === 1, '裸胡（≤7 张）未记到');
ok(A.S.huLog.length === 1, `胡牌记录 ${A.S.huLog.length} 条，应为 1`);
ok(A.S.huLog[0].expr === '8 × 8 × 4 × 4', `记录算式 "${A.S.huLog[0].expr}" 不对`);
ok(A.S.huLog[0].gains.join('') === '🎯 裸胡', `成就 "${A.S.huLog[0].gains}" 不对`);
A.newGame(42); // 结束这局 → 有胡应记入历史
const hist1 = A.loadHist();
ok(hist1.length === 1, `历史对局 ${hist1.length} 条，应为 1`);
ok(hist1[0].hu === 1, `历史记录胡数 ${hist1[0].hu}，应为 1`);
A.newGame(42); // 0 胡局不应记入历史
ok(A.loadHist().length === 1, '无胡对局不该记入历史');

// ---- 6. 除法整除校验 ----
const s5 = { total: 0, sign: 1, curV: 5, last: 'o', lastOp: '/' };
ok(A.placeNum(s5, 2) === null, '5 ÷ 2 不该合法');
ok(A.placeNum(s5, 5) !== null, '5 ÷ 5 应合法');

// ---- 7. 撤销：本回合可回滚，跨回合不可 ----
A.newGame();
A.S.hand = [mk(8), mko('×'), mk(8), mko('×'), mk(4), mko('×')];
A.S.table = []; A.S.st = A.freshState(); A.S.placedThisTurn = 0; A.S.history = [];
put(8); put('×');
ok(A.S.table.length === 2 && A.S.history.length === 2, '落子后应有两步快照');
ok(A.S.hand.length === 4, `落 2 张后手牌 ${A.S.hand.length}，应为 4`);
A.undo();
ok(A.S.table.length === 1, `撤销后桌面 ${A.S.table.length} 张，应为 1`);
ok(A.val(A.S.st) === 8, `撤销后总值 ${A.val(A.S.st)}，应为 8`);
ok(A.S.hand.length === 5, `撤销后手牌 ${A.S.hand.length}，应为 5`);
ok(A.S.hand.some(c => c.kind === 'op' && c.o === '×'), '撤销的 × 应回到手中');
ok(A.S.placedThisTurn === 1, `撤销后本回合计数 ${A.S.placedThisTurn}，应为 1`);
A.endTurn();          // 回合结束 → 快照清空
A.undo();             // 应为空操作
ok(A.S.table.length === 1, '跨回合不该还能撤销');

// ---- 8. 种子：同种子同牌序（测试与复盘的基础） ----
A.newGame(42);
const deal1 = A.S.hand.map(c => (c.kind === 'num' ? `n${c.v ?? 'J'}` : `o${c.o ?? 'W'}`)).join(',');
A.newGame(42);
const deal2 = A.S.hand.map(c => (c.kind === 'num' ? `n${c.v ?? 'J'}` : `o${c.o ?? 'W'}`)).join(',');
A.newGame(43);
const deal3 = A.S.hand.map(c => (c.kind === 'num' ? `n${c.v ?? 'J'}` : `o${c.o ?? 'W'}`)).join(',');
ok(deal1 === deal2, '同种子两次开局牌序不同');
ok(deal1 !== deal3, '不同种子开局牌序相同了');
ok(A.S.seed === 43, `种子未记录 (${A.S.seed})`);
// 胡牌后的洗回也走同一 RNG：跑到死局为止不该抛异常
A.newGame(7);
ok(A.S.deck.length === 108 - A.HAND_SIZE, '种子局牌库数量不对');

// ---- 9. 弃牌：全部手牌移出本局，不洗回 ----
A.newGame(11);
const deckBefore9 = A.S.deck.length;
A.doDiscard();
ok(A.S.discarded === 6, `弃牌计数 ${A.S.discarded}，应为 6`);
ok(A.S.deck.length === deckBefore9 - 6, `牌库 ${A.S.deck.length}，应为 ${deckBefore9 - 6}`);
ok(A.S.hand.length === A.HAND_SIZE, `弃后补牌 ${A.S.hand.length} 张`);
ok(A.S.hand.length + A.S.table.length + A.S.deck.length + A.S.discarded === 108, '弃牌后总数应守恒（含弃牌堆）');
A.doDiscard();
ok(A.S.discarded === 12 && A.S.deck.length === deckBefore9 - 12, '二次弃牌继续消耗牌库');
// 牌库耗尽：连弃到空，手牌不足且不再补
let guard = 0;
while (A.S.deck.length > 0 && guard++ < 30) A.doDiscard();
ok(A.S.deck.length === 0, '牌库应被弃空');
ok(A.S.hand.length <= A.HAND_SIZE, `牌库空后手牌 ${A.S.hand.length} 张，应不超上限`);
ok(A.S.hand.length + A.S.table.length + A.S.discarded === 108, '终局牌数守恒');

// ---- 10. 僵局弃牌换血：真实推导态死局（桌尾数字 + 手中全是数字牌）→ 弃牌后解除 ----
A.newGame(13);
A.S.table = [{ card: { kind: 'num', v: 2, suit: '♠' }, ch: 2 }]; // 桌尾数字，要运算符
A.S.st = { total: 0, sign: 1, curV: 2, last: 'n', lastOp: null };
A.S.hand = [{ kind: 'num', v: 3, suit: '♥' }, { kind: 'num', v: 5, suit: '♦' }]; // 全数字 → 死局
A.S.deck = [{ kind: 'num', v: 3, suit: '♦' }, { kind: 'num', v: 7, suit: '♣' },
            { kind: 'num', v: 1, suit: '♠' }, { kind: 'num', v: 12, suit: '♥' },
            { kind: 'num', v: 5, suit: '♦' }, { kind: 'num', v: 9, suit: '♥' },
            { kind: 'op', o: '+' }];                    // doDiscard 从牌堆顶（数组尾）pop，'+' 必须在末尾
ok(A.isStuck() === true, '应处于死局状态（推导态：没出过牌且无牌可放）');
A.doDiscard();
ok(A.isStuck() === false, '弃牌换血后应解除死局');
ok(A.S.hand.length === A.HAND_SIZE, `换血后手牌 ${A.S.hand.length} 张`);
ok(A.S.hand.some(c => c.kind === 'op'), '新手牌里应有运算符（可继续出牌）');

// ---- 11. 自动存档：中断后恢复，RNG 从断点接上 ----
A.newGame(7);
A.place(0, A.S.hand[0].kind === 'num' ? (A.S.hand[0].joker ? 6 : A.S.hand[0].v) : A.S.hand[0].o); // render → 自动落盘
const savedHu = A.S.hu, savedSeed = A.S.seed;
const savedDeck = JSON.stringify(A.S.deck.map(c => c.v ?? c.o));
const savedTurns = A.S.placedThisTurn;
for (const k of Object.keys(A.S)) delete A.S[k];   // 模拟刷新：内存全丢
ok(A.resumeGame() === true, '应能从存档恢复');
ok(A.S.seed === savedSeed, `恢复后种子 ${A.S.seed}，应为 ${savedSeed}`);
ok(A.S.hu === savedHu, '恢复后胡数不对');
ok(A.S.placedThisTurn === savedTurns, '恢复后本回合计数不对');
ok(JSON.stringify(A.S.deck.map(c => c.v ?? c.o)) === savedDeck, '恢复后牌库顺序不对');
ok(typeof A.S.rng === 'function', '恢复后 RNG 未重建');
// 恢复后的局继续推进：走完一整局不崩（洗牌用重建的 RNG）
let turns11 = 0;
while (!A.isStuck() && turns11++ < 400) {
  let guard = 0;
  while (!A.isStuck() && guard++ < 12) {
    const mv = findMove();
    if (!mv) break;
    A.place(mv.idx, mv.ch);
  }
  if (A.isStuck()) break;
  if (A.S.placedThisTurn === 0) break;
  A.endTurn();
}
ok(A.S.hand.length + A.S.table.length + A.S.deck.length + A.S.discarded === 108, '续玩对局牌数应守恒');
// 无存档 → 恢复失败
store.delete('h1024.save');
ok(A.resumeGame() === false, '无存档不应恢复成功');

console.log(fails === 0 ? '✓ 全部通过' : `✗ ${fails} 项失败`);
process.exit(fails ? 1 : 0);
