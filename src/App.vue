<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { HAND_SIZE, TARGET, val } from './engine/engine'
import { OPS, rankLabel } from './engine/cards'
import type { Card, OpSymbol } from './engine/types'
import {
  S, fx, sheet, closeSheet, openSheet, resumeGame, peekSave, loadHist, deleteHistEntry, clearHist, URL_SEED, toast,
} from './game/state'
import {
  place, drawToFull, undo, doDiscard, newGame, doHu,
  placementFor, unplayableReason,
} from './game/actions'

// 启动：复盘链接（?seed=）直接开局；否则弹开始菜单（新游戏 / 继续上局 / 历史记录）
if (URL_SEED) newGame()
else openSheet('start')

// ---- 总值 ----
const current = computed(() => val(S.st))
const valueCls = computed(() => 'value' + (current.value === TARGET ? ' hit' : current.value >= 512 ? ' near' : ''))

// ---- 桌面算式 token（迷你牌面：与手牌同比例同排版；标记最后一个乘积项）----
const tokens = computed(() => {
  let termStart = 0
  S.table.forEach((t, i) => {
    if (t.card.kind === 'op' && (t.ch === '+' || t.ch === '-')) termStart = i + 1
  })
  return S.table.map((t, i) => {
    const isOp = t.card.kind === 'op'
    const joker = t.card.kind === 'num' && !!t.card.joker
    const wildOp = t.card.kind === 'op' && !!t.card.wild
    const red = t.card.suit === '♥' || t.card.suit === '♦'
    return {
      // 万能牌（王/任意运算）也显示成实际打出的牌面，仅以虚线框+✦角标标记
      label: isOp ? String(t.ch) : rankLabel(t.ch as number),
      suit: t.card.suit ?? '',
      isOp,
      isWild: wildOp || joker,
      red,
      termLast: i >= termStart,
    }
  })
})

// ---- 手牌：按座位号渲染，出牌后空位留在原位 ----
const handSlots = computed(() => Array.from({ length: HAND_SIZE }, (_, s) => {
  const idx = S.hand.findIndex(c => c.slot === s)
  const card = idx >= 0 ? S.hand[idx] : null
  return { s, idx, card, placement: card ? placementFor(card) : null }
}))

function cardCls(card: Card, placement: ReturnType<typeof placementFor>) {
  const red = card.kind === 'num'
    ? !card.joker && (card.suit === '♥' || card.suit === '♦')
    : card.suit === '♥' || card.suit === '♦'
  return [
    'card', card.kind === 'num' ? 'n' : 'o',
    placement ? 'playable' : 'dim',
    red ? 'red' : '',
    card.kind === 'op' && card.wild ? 'wildc' : '',
  ]
}

// ---- 发牌动画：从牌堆/弃牌堆真实位置逐张飞到手牌位（蜘蛛纸牌式，WAAPI 单一时间线） ----
// 每张牌只有两个 el.animate：飞行（transform+opacity，delay 期间 fill:backwards 停在牌堆）+
// 翻面（落定站稳后 scaleX 展开，亮度同步过渡到最终态）。无内联样式、无 transition 交接。
watch(() => fx.drawAt, () => {
  nextTick(() => {
    const deck = document.querySelector<HTMLElement>(`.pile[data-pile="${fx.drawFrom}"]`)
    if (!deck) return
    const dr = deck.getBoundingClientRect()
    const news = S.hand.filter(c => c.drawn)
    news.forEach((c, i) => {
      const el = document.querySelector<HTMLElement>(`.hand .card[data-slot="${c.slot}"]`)
      if (!el) return
      const r = el.getBoundingClientRect()
      const dx = dr.left + dr.width / 2 - (r.left + r.width / 2)
      const dy = dr.top + dr.height / 2 - (r.top + r.height / 2)
      el.classList.add('dealing')                     // 牌背朝上（飞行全程）
      el.animate(
        [
          { transform: `translate(${dx}px, ${dy}px) scale(.6)`, opacity: 1 },   // 等待时缩小叠在牌堆上
          { transform: 'none', opacity: 1 },                                   // 起飞展开到全尺寸
        ],
        { duration: 450, delay: 60 + i * 110, easing: 'cubic-bezier(.2,.7,.3,1)', fill: 'backwards' },
      )
      // 落定站稳一拍（飞行止于 510+i*110）后翻面；亮度同步过渡到最终态（dim 一步到位）
      setTimeout(() => {
        el.classList.remove('dealing')
        const finalOpacity = Number(getComputedStyle(el).opacity)
        el.animate(
          [
            { transform: 'scaleX(.15)', opacity: 1 },
            { transform: 'scaleX(1)', opacity: finalOpacity },
          ],
          { duration: 350, easing: 'ease-out' },
        )
        setTimeout(() => { delete c.drawn }, 400)
      }, 60 + i * 110 + 560)
    })
  })
})

// 撤销补牌：刚补的牌翻面后从手牌飞回牌库（渲染前克隆旧元素，fixed 层飞行不受裁剪）
watch(() => fx.returnAt, () => {
  const deck = document.querySelector<HTMLElement>('.pile[data-pile="deck"] .pile-stack')
  if (!deck) return
  const dr = deck.getBoundingClientRect()
  fx.returnSlots.forEach((slot, i) => {
    const el = document.querySelector<HTMLElement>(`.hand .card[data-slot="${slot}"]`)
    if (!el) return
    const r = el.getBoundingClientRect()
    const fly = el.cloneNode(true) as HTMLElement
    fly.style.cssText += `position:fixed;left:${r.left}px;top:${r.top}px;width:${r.width}px;height:${r.height}px;margin:0;z-index:40;pointer-events:none;animation:none;`
    document.body.appendChild(fly)
    const dx = dr.left + dr.width / 2 - (r.left + r.width / 2)
    const dy = dr.top + dr.height / 2 - (r.top + r.height / 2)
    const d = i * 60
    fly.animate(
      [{ transform: 'scaleX(1)' }, { transform: 'scaleX(.08)' }],
      { duration: 150, delay: d, easing: 'ease-in', fill: 'forwards' },
    )
    setTimeout(() => fly.classList.add('dealing'), d + 150)   // 中点换牌背
    fly.animate(
      [{ transform: 'scaleX(.08)' }, { transform: 'scaleX(1)' }],
      { duration: 200, delay: d + 150, easing: 'ease-out', fill: 'forwards' },
    )
    fly.animate(
      [
        { transform: 'translate(0,0) rotate(0deg) scale(1)' },
        { transform: `translate(${dx}px, ${dy}px) rotate(10deg) scale(.5)` },
      ],
      { duration: 450, delay: d + 350, easing: 'cubic-bezier(.4,0,.7,.3)', fill: 'forwards' },
    )
    fly.animate(
      [{ opacity: 1 }, { opacity: 0 }],
      { duration: 180, delay: d + 620, easing: 'ease-in', fill: 'forwards' },
    )
    setTimeout(() => fly.remove(), d + 830)
  })
})

// 撤销出牌：桌尾 token 飞回对应手牌座位（渲染前克隆，飞行中放大成牌尺寸，真身延后现身）
watch(() => fx.undoPlaceAt, () => {
  const tok = document.querySelector<HTMLElement>('.expr .tok:last-child')
  const seat = document.querySelectorAll<HTMLElement>('.hand .seat')[fx.undoPlaceSlot]
  if (!tok || !seat) return
  const tr = tok.getBoundingClientRect()
  const fly = tok.cloneNode(true) as HTMLElement
  fly.style.cssText += `position:fixed;left:${tr.left}px;top:${tr.top}px;width:${tr.width}px;height:${tr.height}px;margin:0;z-index:40;pointer-events:none;animation:none;`
  document.body.appendChild(fly)
  const sr = seat.getBoundingClientRect()
  const dx = sr.left + sr.width / 2 - (tr.left + tr.width / 2)
  const dy = sr.top + sr.height / 2 - (tr.top + tr.height / 2)
  const scale = sr.width / tr.width
  fly.animate(
    [
      { transform: 'translate(0,0) rotate(0deg) scale(1)' },
      { transform: `translate(${dx * 0.5}px, ${dy * 0.5}px) rotate(-6deg) scale(${(1 + scale) / 2})`, offset: 0.7 },
      { transform: `translate(${dx}px, ${dy}px) rotate(0deg) scale(${scale})` },
    ],
    { duration: 380, easing: 'cubic-bezier(.2,.7,.3,1)', fill: 'forwards' },
  )
  nextTick(() => {
    const card = seat.querySelector<HTMLElement>('.card')
    if (!card) { fly.remove(); return }
    card.style.visibility = 'hidden'            // 真身藏到克隆落地
    setTimeout(() => {
      card.style.visibility = ''
      card.animate(
        [{ transform: 'scale(.9)', opacity: .5 }, { transform: 'scale(1)', opacity: 1 }],
        { duration: 150, easing: 'ease-out' },
      )
      fly.remove()
    }, 400)
  })
})

// 补牌：从牌库补满手牌（满了/没牌了给轻提示）
function onDrawClick() {
  if (!drawToFull()) toast(S.hand.length >= HAND_SIZE ? '手牌已满' : '牌库已空')
}

// 弃牌：手牌先逐张翻面（正面→牌背），再背面朝上飞向弃牌堆（WAAPI 关键帧，时序确定），飞完才真正执行（可撤销）
const discarding = ref(false)
function onDiscardClick() {
  if (!canDiscard.value || discarding.value) return
  const pile = document.querySelector<HTMLElement>('.pile[data-pile="discard"]')
  const els = Array.from(document.querySelectorAll<HTMLElement>('.hand .card'))
  if (!pile || !els.length) { doDiscard(); return }
  discarding.value = true
  const pr = pile.getBoundingClientRect()
  S.hand.forEach(c => { c.drawn = true })   // 起飞即亮出座位虚框（牌一离开，虚框立刻接上）
  els.forEach(el => { el.style.opacity = '1' })   // 弃牌飞行全程实体（dim 牌不带灰度飞）
  let lastEnd = 0
  els.forEach((el, i) => {
    const delay = i * 50               // 逐张错峰
    const r = el.getBoundingClientRect()
    const dx = pr.left + pr.width / 2 - (r.left + r.width / 2)
    const dy = pr.top + pr.height / 2 - (r.top + r.height / 2)
    // 第一段：正面收窄到侧面（正面全程可见）
    el.animate(
      [{ transform: 'scaleX(1)' }, { transform: 'scaleX(.08)' }],
      { duration: 150, delay, easing: 'ease-in', fill: 'forwards' },
    )
    // 中点换牌背，并展开回全宽（不在侧面薄条状态下起飞）
    setTimeout(() => el.classList.add('dealing'), delay + 150)
    el.animate(
      [{ transform: 'scaleX(.08)' }, { transform: 'scaleX(1)' }],
      { duration: 200, delay: delay + 150, easing: 'ease-out', fill: 'forwards' },
    )
    // 背面朝上飞向弃牌堆
    el.animate(
      [
        { transform: 'translate(0,0) rotate(0deg) scale(1)' },
        { transform: `translate(${dx}px, ${dy}px) rotate(-12deg) scale(.5)` },
      ],
      { duration: 500, delay: delay + 350, easing: 'cubic-bezier(.4,0,.7,.3)', fill: 'forwards' },
    )
    // 临堆渐隐（最后 180ms）
    el.animate(
      [{ opacity: 1 }, { opacity: 0 }],
      { duration: 180, delay: delay + 670, easing: 'ease-in', fill: 'forwards' },
    )
    lastEnd = Math.max(lastEnd, delay + 850)
  })
  setTimeout(() => {
    doDiscard()
    discarding.value = false
  }, lastEnd + 80)
}

// 出牌：先记下手牌位置，落桌后让新 token 从手牌位置飞入（FLIP）
// 胡牌不自动结算——凑到 1024 后亮出「胡」按钮，由玩家手动触发
function placeWithFly(idx: number, ch: number | OpSymbol) {
  const hs = handSlots.value.find(h => h.idx === idx)
  const el = hs ? document.querySelector<HTMLElement>(`.hand .card[data-slot="${hs.s}"]`) : null
  const from = el ? el.getBoundingClientRect() : null
  place(idx, ch, { deferHu: true })

  if (!from) return
  nextTick(() => {
    const tok = document.querySelector<HTMLElement>('.expr .tok:last-child')
    if (!tok) return
    const to = tok.getBoundingClientRect()
    const dx = from.left + from.width / 2 - (to.left + to.width / 2)
    const dy = from.top + from.height / 2 - (to.top + to.height / 2)
    const scale = from.width / to.width
    const expr = exprEl.value
    if (expr) expr.style.overflow = 'hidden'   // 飞行偏移不撑出滚动条
    const fly = tok.animate(
      [
        { transform: `translate(${dx}px, ${dy}px) scale(${scale})` },
        { transform: 'translate(0,0) scale(1)' },
      ],
      { duration: 380, easing: 'cubic-bezier(.2,.7,.3,1)' },
    )
    fly.finished.then(() => {
      if (expr) expr.style.overflow = ''
    }).catch(() => {})
  })
}

// 整桌算式逐个翻面（正面→牌背）再背面朝上飞回牌库（胡牌结算前置动画），飞完回调 doHu
// 用 fixed 克隆层飞行：真 token 原地隐藏（不出滚动条），克隆挂在 body 上（不受 felt overflow 裁剪，能完整飞到牌堆）
function flyTableToDeck(done: () => void) {
  const deck = document.querySelector<HTMLElement>('.pile[data-pile="deck"] .pile-stack')
  const toks = Array.from(document.querySelectorAll<HTMLElement>('.expr .tok'))
  if (!deck || !toks.length) { done(); return }
  const dr = deck.getBoundingClientRect()
  let lastEnd = 0
  const clones: HTMLElement[] = []
  toks.forEach((tok, i) => {
    const r = tok.getBoundingClientRect()
    const fly = tok.cloneNode(true) as HTMLElement
    fly.style.cssText += `position:fixed;left:${r.left}px;top:${r.top}px;width:${r.width}px;height:${r.height}px;margin:0;z-index:30;pointer-events:none;animation:none;`
    document.body.appendChild(fly)
    clones.push(fly)
    tok.style.visibility = 'hidden'
    const dx = dr.left + dr.width / 2 - (r.left + r.width / 2)
    const dy = dr.top + dr.height / 2 - (r.top + r.height / 2)
    const d = i * 40
    // 第一段：正面收窄到侧面
    fly.animate(
      [{ transform: 'scaleX(1)' }, { transform: 'scaleX(.08)' }],
      { duration: 150, delay: d, easing: 'ease-in', fill: 'forwards' },
    )
    // 中点换牌背，展开回全宽
    setTimeout(() => fly.classList.add('facedown'), d + 150)
    fly.animate(
      [{ transform: 'scaleX(.08)' }, { transform: 'scaleX(1)' }],
      { duration: 200, delay: d + 150, easing: 'ease-out', fill: 'forwards' },
    )
    // 背面朝上飞向牌库
    fly.animate(
      [
        { transform: 'translate(0,0) rotate(0deg) scale(1)' },
        { transform: `translate(${dx}px, ${dy}px) rotate(-10deg) scale(.6)` },
      ],
      { duration: 450, delay: d + 350, easing: 'cubic-bezier(.5,0,.8,.4)', fill: 'forwards' },
    )
    // 临堆渐隐（最后 180ms）
    fly.animate(
      [{ opacity: 1 }, { opacity: 0 }],
      { duration: 180, delay: d + 620, easing: 'ease-in', fill: 'forwards' },
    )
    lastEnd = Math.max(lastEnd, d + 800)
  })
  setTimeout(() => {
    clones.forEach(c => c.remove())
    toks.forEach(t => { t.style.visibility = '' })
    done()
  }, lastEnd + 80)
}

function onCardClick(idx: number) {
  const card = S.hand[idx]
  if (!card) return
  const p = placementFor(card)
  if (!p) { toast(unplayableReason(card)); return }   // 不可打出：轻提示原因
  if (p.pick === 'num') { openSheet('pickNum', { idx }); return }
  if (p.pick === 'op') { openSheet('pickOp', { idx }); return }
  placeWithFly(idx, p.ch!)
}

function numOk(v: number) {
  return S.st.lastOp === '/' ? S.st.curV! % v === 0 : true
}
function chooseNum(v: number) {
  const idx = sheet.value!.payload!.idx as number
  closeSheet()
  placeWithFly(idx, v)
}
function chooseOp(o: OpSymbol) {
  const idx = sheet.value!.payload!.idx as number
  closeSheet()
  placeWithFly(idx, o)
}

// ---- 按钮状态 ----
const isDev = import.meta.env.DEV
const canUndo = computed(() => S.undoStack.length > 0)
const canDiscard = computed(() => S.hand.length > 0)
const canHu = computed(() => S.table.length > 0 && current.value === TARGET)
function onHuClick() {
  flyTableToDeck(() => doHu())
}

// ---- 弹层：牌堆详情 ----
const pileCells = computed(() => {
  const p = sheet.value
  if (!p || p.kind !== 'pile') return null
  const cards = p.payload!.cards as Card[]
  const num = Array(14).fill(0)
  let joker = 0, wild = 0
  const op: Record<string, number> = { '+': 0, '-': 0, '×': 0, '÷': 0 }
  for (const c of cards) {
    if (c.kind === 'num') c.joker ? joker++ : num[c.v]++
    else c.wild ? wild++ : op[c.o!]++
  }
  const cell = (label: string, n: number) => ({ label, n, zero: !n })
  return {
    title: p.payload!.title as string,
    count: cards.length,
    numCells: Array.from({ length: 13 }, (_, k) => k + 1).map(v => cell(rankLabel(v), num[v])),
    opCells: [...OPS.map(o => cell(o, op[o])), cell('任意', wild), cell('✦', joker)],
  }
})

// ---- 弹层：历史对局 ----
// localStorage 不在响应式系统里，histVer 手动挡版本号触发重算
const histVer = ref(0)
const histRows = computed(() => {
  histVer.value
  if (sheet.value?.kind !== 'history') return []
  return loadHist().map((g, i) => {
    const d = new Date(g.ts), p2 = (n: number) => String(n).padStart(2, '0')
    return { n: i + 1, hu: g.hu, seed: g.seed, time: `${d.getMonth() + 1}/${d.getDate()} ${p2(d.getHours())}:${p2(d.getMinutes())}` }
  })
})

function removeHist(index: number) {
  deleteHistEntry(index)
  histVer.value++
}

// 全部清空：两步确认（第一次点变成红色确认态，再点才清）
const confirmClear = ref(false)
watch(sheet, () => { confirmClear.value = false })   // 换弹层/关弹层时重置确认态
function clearAllHist() {
  if (!confirmClear.value) { confirmClear.value = true; return }
  clearHist()
  histVer.value++
  confirmClear.value = false
}

// 用历史记录里的种子重开一局
function replaySeed(seed: number) {
  closeSheet()
  newGame(seed)
}

// ---- 弹层：开始菜单 ----
const savedInfo = computed(() => (sheet.value?.kind === 'start' ? peekSave() : null))
function startNewGame() {
  closeSheet()
  newGame()
}
function continueSaved() {
  closeSheet()
  if (!resumeGame()) newGame()   // 存档损坏时兜底开新局
}
// 从弹层返回：还没开局（开始菜单进来的历史记录）就回到开始菜单
function leaveSheet() {
  if (S.deck.length === 0) openSheet('start')
  else closeSheet()
}

async function copySeedLink(seed: number) {
  const link = `${location.origin}${location.pathname}?seed=${seed}`
  try { await navigator.clipboard.writeText(link); toast('已复制复盘链接') }
  catch { toast(`种子 ${seed}`) }
}

// ---- 特效：toast / 胡牌 ----
// 堆叠式：每条提示独立一行由上到下顺排，各自 1.8s 后自行消失，互不影响
const toasts = ref<{ id: number; text: string }[]>([])
let toastSeq = 0
watch(() => fx.toastAt, () => {
  const id = ++toastSeq
  toasts.value.unshift({ id, text: fx.toast })   // 最新在最上，越靠下越旧
  setTimeout(() => { toasts.value = toasts.value.filter(t => t.id !== id) }, 1800)
})

const exprEl = ref<HTMLElement | null>(null)
watch(() => S.table.length, async () => {
  await nextTick()
  if (exprEl.value) exprEl.value.scrollTop = exprEl.value.scrollHeight
})

// ---- 快捷键 ----
function onKey(e: KeyboardEvent) {
  if (e.key === 'z' || e.key === 'Z' || (e.metaKey && e.key === 'z') || (e.ctrlKey && e.key === 'z')) {
    e.preventDefault()
    undo()
  }
}
onMounted(() => window.addEventListener('keydown', onKey))
onUnmounted(() => window.removeEventListener('keydown', onKey))
</script>

<template>
  <header>
    <div class="brand">胡<b>1024</b></div>
    <div class="top-actions">
      <button class="icon-btn" aria-label="规则" @click="openSheet('help')">?</button>
      <button class="top-btn" @click="openSheet('restart')">重开</button>
      <button class="top-btn" title="历史对局" @click="openSheet('history')">历史</button>
      <button v-if="isDev" class="top-btn" title="强制胡牌（仅开发模式）" @click="onHuClick()">强胡</button>
    </div>
  </header>

  <main>
    <aside class="hu-panel">
      <div class="hu-head">
        <h3>胡牌记录</h3>
      </div>
      <p v-if="!S.huLog.length" class="hu-empty">胡了会显示在这里</p>
      <div v-else class="hu-list">
        <div v-for="(r, i) in S.huLog" :key="i" class="hurec">
          <i>#{{ i + 1 }}</i>
          <b>{{ r.expr }}</b>
          <em v-if="r.gains.length">{{ r.gains.join(' ') }}</em>
        </div>
      </div>
    </aside>
    <div class="felt">
      <div :class="valueCls">{{ current }}<span class="target">目标 1024</span></div>
      <div ref="exprEl" class="expr">
        <span v-if="!S.table.length" class="empty">出牌，让牌桌走向 1024</span>
        <span v-for="(t, i) in tokens" :key="i" :class="['tok', t.red ? 'red' : '', { 'term-last': t.termLast, wild: t.isWild }]">
          <span class="rank">{{ t.label }}</span>
          <i v-if="t.isWild" class="star">✦</i>
          <span v-else-if="t.suit" class="suit">{{ t.suit }}</span>
        </span>
      </div>
    </div>
    <aside class="piles">
      <button class="pile" data-pile="deck" title="剩余牌库" @click="openSheet('pile', { title: '牌库', cards: S.deck })">
        <span class="pile-stack" :class="{ empty: !S.deck.length }"></span>
        <span class="pile-name">牌库</span>
        <span class="pile-count">{{ S.deck.length }}</span>
      </button>
      <button class="pile" data-pile="discard" title="弃牌堆" @click="openSheet('pile', { title: '弃牌堆', cards: S.discardPile })">
        <span class="pile-stack discard" :class="{ empty: !S.discarded }"></span>
        <span class="pile-name">弃牌</span>
        <span class="pile-count">{{ S.discarded }}</span>
      </button>
      <button v-if="canHu" class="btn primary hu-btn" @click="onHuClick()">胡</button>
    </aside>
  </main>

  <div class="hand-wrap">
    <div class="hand">
      <div v-for="hs in handSlots" :key="hs.s" class="seat">
        <div v-if="!hs.card || hs.card.drawn" class="slot" :style="{ animationDelay: hs.s * 30 + 'ms' }"></div>
        <button
          v-if="hs.card"
          :class="cardCls(hs.card, hs.placement)"
          :data-slot="hs.s"
          :style="{ animationDelay: hs.s * 30 + 'ms' }"
          @click="onCardClick(hs.idx)"
        >
          <template v-if="hs.card.kind === 'num'">
            <template v-if="hs.card.joker"><span class="gl">✦</span><span class="sub">万能</span></template>
            <template v-else><span class="rank">{{ rankLabel(hs.card.v) }}</span><span class="suit">{{ hs.card.suit }}</span></template>
          </template>
          <template v-else>
            <template v-if="hs.card.wild"><span class="rank">?</span><span class="sub">任意运算</span></template>
            <template v-else><span class="rank">{{ hs.card.o }}</span><span class="suit">{{ hs.card.suit ?? '' }}</span></template>
          </template>
        </button>
      </div>
    </div>
  </div>

  <footer>
    <button class="btn ghost" :disabled="!canUndo" @click="undo()">撤销</button>
    <button class="btn ghost" :disabled="!canDiscard || discarding" @click="onDiscardClick()">弃牌</button>
    <button class="btn ghost" @click="onDrawClick()">补牌</button>
  </footer>

  <!-- 弹层 -->
  <div class="overlay" :class="{ show: !!sheet }" @click.self="leaveSheet()">
    <div v-if="sheet" class="sheet" :class="{ wide: ['history', 'huLog', 'pile'].includes(sheet.kind), history: sheet.kind === 'history' }">
      <template v-if="sheet.kind === 'help'">
        <h2>怎么玩</h2>
        <p>往牌桌上依次放牌，数字和运算符必须交替。牌桌是一整个算式，按四则运算优先级求值。</p>
        <p>总值恰好等于 <b style="color:#ffd76a">1024</b> 就「胡」——桌牌洗回牌库，继续下一手。</p>
        <p>手牌 {{ HAND_SIZE }} 张。牌一旦上桌就收不回来——但<b>胡牌之前</b>都可以撤销（含弃牌）。</p>
        <p>凑不上想换血？「弃牌」弃掉当前整手牌——弃掉的牌<b>移出本局</b>，点「补牌」补满（牌库会越弃越薄）。</p>
        <p style="color:#8a7442">最短的一手要 7 张牌，例如 13 × 13 × 6 + 10 或 8 × 8 × 4 × 4</p>
        <div class="actions"><button class="btn primary" @click="closeSheet()">知道了</button></div>
      </template>

      <template v-else-if="sheet.kind === 'restart'">
        <h2>重开</h2>
        <div class="actions start-actions">
          <button class="btn primary" :disabled="!S.deck.length" @click="closeSheet(); newGame(S.seed)">重来本局</button>
          <button class="btn ghost" @click="closeSheet(); newGame()">新开一局</button>
        </div>
      </template>

      <template v-else-if="sheet.kind === 'pickNum'">
        <h2>这张王当几用</h2>
        <p>选一个数值替它上桌。</p>
        <div class="picker">
          <button v-for="v in 13" :key="v" :disabled="!numOk(v)" @click="chooseNum(v)">{{ rankLabel(v) }}</button>
        </div>
      </template>

      <template v-else-if="sheet.kind === 'pickOp'">
        <h2>任意运算符</h2>
        <p>选一个运算符替它上桌。</p>
        <div class="picker">
          <button v-for="o in OPS" :key="o" class="op" @click="chooseOp(o)">{{ o }}</button>
        </div>
      </template>

      <template v-else-if="sheet.kind === 'pile' && pileCells">
        <h2>{{ pileCells.title }} · {{ pileCells.count }} 张</h2>
        <div class="pgrid">
          <div v-for="(c, i) in pileCells.numCells" :key="'n' + i" class="pcell" :class="{ zero: c.zero }"><b>{{ c.label }}</b><i>{{ c.n }}</i></div>
        </div>
        <div class="pgrid">
          <div v-for="(c, i) in pileCells.opCells" :key="'o' + i" class="pcell" :class="{ zero: c.zero }"><b>{{ c.label }}</b><i>{{ c.n }}</i></div>
        </div>
        <div class="actions"><button class="btn primary" @click="closeSheet()">知道了</button></div>
      </template>

      <template v-else-if="sheet.kind === 'huLog'">
        <h2>胡牌记录 · {{ S.huLog.length }} 胡</h2>
        <div class="sheet-body">
          <template v-if="S.huLog.length">
            <div v-for="(r, i) in S.huLog" :key="i" class="hurow">
              <i>#{{ i + 1 }}</i><b>{{ r.expr }}</b><em v-if="r.gains.length">{{ r.gains.join(' ') }}</em>
            </div>
          </template>
          <p v-else>本局还没有胡牌</p>
        </div>
        <div class="actions"><button class="btn primary" @click="closeSheet()">知道了</button></div>
      </template>

      <template v-else-if="sheet.kind === 'history'">
        <div class="sheet-head">
          <h2>历史对局 · {{ histRows.length }} 局</h2>
          <button v-if="histRows.length" class="clear-btn" :class="{ armed: confirmClear }" @click="clearAllHist">
            {{ confirmClear ? '确认清空？' : '清空' }}
          </button>
        </div>
        <div class="sheet-body">
          <template v-if="histRows.length">
            <div v-for="g in histRows" :key="g.n" class="hurow" style="cursor:pointer" @click="copySeedLink(g.seed)">
              <i>#{{ g.n }}</i><b>{{ g.hu }} 胡</b><em>{{ g.time }} · 种子 {{ g.seed }}</em>
              <button class="replay-btn" title="用该种子重开一局" @click.stop="replaySeed(g.seed)">重开</button>
              <button class="del-btn" title="删除这条记录" @click.stop="removeHist(g.n - 1)">×</button>
            </div>
          </template>
          <p v-else>还没有完成的对局</p>
        </div>
        <div class="actions"><button class="btn primary" @click="leaveSheet()">知道了</button></div>
      </template>

      <template v-else-if="sheet.kind === 'start'">
        <h2>胡 1024</h2>
        <p>用扑克牌和四则运算凑出恰好 1024。</p>
        <div class="actions start-actions">
          <button class="btn primary" @click="startNewGame()">新游戏</button>
          <button v-if="savedInfo" class="btn ghost" @click="continueSaved()">继续上局 · {{ savedInfo.hu }} 胡</button>
          <button class="btn ghost" @click="openSheet('history')">历史记录</button>
        </div>
      </template>
    </div>
  </div>

  <!-- 特效 -->
  <div :key="fx.burstAt" class="hu-burst" :class="{ go: fx.burstAt > 0 }"></div>
  <div :key="'w' + fx.burstAt" class="hu-word" :class="{ go: fx.burstAt > 0 }">胡</div>
  <div class="toast-wrap">
    <div v-for="t in toasts" :key="t.id" class="toast">{{ t.text }}</div>
  </div>
</template>
