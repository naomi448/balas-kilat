// Balas Kilat — G2 app state machine.
// Screens: S0 empty, S1 digest, S2 detail, S3 draft+confirm, S4 sent,
// plus the one-line error state. One idea + one action per screen.
// Tap always works; voice phrases are accelerators only.

import './style.css'
import { pickApi, type Api, type DigestItem } from './api'
import { BridgeRenderer, DomRenderer, type InputAction, type Renderer, type Screen } from './render'
import { wrap, paginate, oneLine } from './text'
import { listenOnce, matchVoicePhrase, type VoiceAction } from './voice'

type State =
  | { name: 'loading' }
  | { name: 'empty' }
  | { name: 'error'; line: string; retry: () => void }
  | { name: 'digest'; items: DigestItem[]; total: number; cursor: number; offset: number }
  | { name: 'detail'; item: DigestItem; page: number }
  | { name: 'drafting'; item: DigestItem }
  | { name: 'draft'; item: DigestItem; draft: string; count: number }
  | { name: 'sending'; item: DigestItem; draft: string; count: number }
  | { name: 'sent'; item: DigestItem }

const MAX_DRAFTS = 3
const VISIBLE = 3 // digest items per screen (2 lines each + header = 7)

const api: Api = pickApi()
let state: State = { name: 'loading' }
let digestCache: { items: DigestItem[]; total: number } = { items: [], total: 0 }
let opSeq = 0

// ------------------------------------------------------------ screens

function screenFor(s: State): Screen {
  switch (s.name) {
    case 'loading':
      return { lines: ['Loading…'] }
    case 'empty':
      return { lines: ['All caught up. ✓', '', 'TAP: refresh'] }
    case 'error':
      return { lines: [oneLine(s.line), '', 'TAP: retry'] }
    case 'digest': {
      const lines: string[] = [`TELEGRAM · ${s.total} unread`]
      let selected = -1
      const win = s.items.slice(s.offset, s.offset + VISIBLE)
      win.forEach((it, i) => {
        const idx = s.offset + i
        const cur = idx === s.cursor
        if (cur) selected = lines.length
        lines.push((cur ? '> ' : '  ') + oneLine(it.chat, 27))
        lines.push('  "' + oneLine(it.summary, 25) + '"')
      })
      if (s.items.length <= 2) lines.push('TAP: open · scroll: pick')
      return { lines, selected }
    }
    case 'detail': {
      const pages = paginate(wrap(s.item.text), 5)
      const page = Math.min(s.page, pages.length - 1)
      const hint =
        pages.length > 1
          ? `p${page + 1}/${pages.length} · TAP draft · 2TAP back`
          : 'TAP: draft · 2TAP: back'
      return {
        lines: [
          oneLine(`${s.item.sender} · ${s.item.time}`),
          ...(pages[page] ?? []),
          hint,
        ],
      }
    }
    case 'drafting':
      return { lines: ['Drafting reply…', '', 'one moment'] }
    case 'draft': {
      const hint =
        s.count >= MAX_DRAFTS ? 'TAP send · drafts maxed' : 'TAP send · SWIPE new draft'
      return {
        lines: [`DRAFT ${s.count}/${MAX_DRAFTS}:`, ...wrap(s.draft).slice(0, 4), '', hint],
      }
    }
    case 'sending':
      return { lines: ['Sending…'] }
    case 'sent':
      return {
        lines: [`✓ Sent to ${oneLine(s.item.sender, 19)}`, '', 'Next unread →', 'TAP: next'],
      }
  }
}

// ------------------------------------------------------------ rendering

const renderers: Renderer[] = []
function render(): void {
  const scr = screenFor(state)
  renderers.forEach((r) => r.show(scr))
}
function setState(s: State): void {
  state = s
  render()
}

// ------------------------------------------------------------ flows

async function loadDigest(selectFirst = true): Promise<void> {
  const seq = ++opSeq
  setState({ name: 'loading' })
  try {
    const d = await api.digest()
    if (seq !== opSeq) return
    digestCache = { items: d.items, total: d.count }
    if (d.items.length === 0) setState({ name: 'empty' })
    else {
      setState({
        name: 'digest',
        items: d.items,
        total: d.count,
        cursor: selectFirst ? 0 : 0,
        offset: 0,
      })
    }
  } catch {
    if (seq !== opSeq) return
    setState({
      name: 'error',
      line: 'Offline — retry',
      retry: () => void loadDigest(),
    })
  }
}

async function requestDraft(item: DigestItem, instruction?: string): Promise<void> {
  const seq = ++opSeq
  setState({ name: 'drafting', item })
  try {
    const r = await api.draft(item.id, instruction)
    if (seq !== opSeq) return
    setState({ name: 'draft', item, draft: r.draft, count: r.draftCount })
  } catch {
    if (seq !== opSeq) return
    setState({
      name: 'error',
      line: 'Draft failed — retry',
      retry: () => void requestDraft(item, instruction),
    })
  }
}

async function doSend(item: DigestItem, draft: string, count: number): Promise<void> {
  const seq = ++opSeq
  setState({ name: 'sending', item, draft, count })
  try {
    await api.send(item.id, draft)
    if (seq !== opSeq) return
    setState({ name: 'sent', item })
  } catch {
    if (seq !== opSeq) return
    setState({
      name: 'error',
      line: 'Send failed — retry',
      retry: () => setState({ name: 'draft', item, draft, count }),
    })
  }
}

async function skipItem(item: DigestItem): Promise<void> {
  const seq = ++opSeq
  try {
    await api.skip(item.id)
  } catch {
    /* skipping is best-effort; the item also drops server-side on send */
  }
  if (seq !== opSeq) return
  void loadDigest()
}

// ------------------------------------------------------------ input

function onInput(a: InputAction): void {
  const s = state
  switch (s.name) {
    case 'loading':
    case 'drafting':
    case 'sending':
      return
    case 'empty':
      if (a === 'tap') void loadDigest()
      return
    case 'error':
      if (a === 'tap' || a === 'back') s.retry()
      return
    case 'digest': {
      if (a === 'scrollDown' || a === 'scrollUp') {
        const d = a === 'scrollDown' ? 1 : -1
        const cursor = Math.max(0, Math.min(s.items.length - 1, s.cursor + d))
        let offset = s.offset
        if (cursor < offset) offset = cursor
        if (cursor >= offset + VISIBLE) offset = cursor - VISIBLE + 1
        setState({ ...s, cursor, offset })
      } else if (a === 'tap') {
        const item = s.items[s.cursor]
        if (item) setState({ name: 'detail', item, page: 0 })
      }
      return
    }
    case 'detail': {
      const pages = paginate(wrap(s.item.text), 5)
      if (a === 'scrollDown') {
        setState({ ...s, page: Math.min(pages.length - 1, s.page + 1) })
      } else if (a === 'scrollUp') {
        setState({ ...s, page: Math.max(0, s.page - 1) })
      } else if (a === 'tap') {
        void requestDraft(s.item)
      } else if (a === 'back') {
        setState({
          name: 'digest',
          items: digestCache.items,
          total: digestCache.total,
          cursor: Math.max(0, digestCache.items.findIndex((i) => i.id === s.item.id)),
          offset: 0,
        })
      }
      return
    }
    case 'draft': {
      if (a === 'tap') {
        void doSend(s.item, s.draft, s.count)
      } else if (a === 'scrollDown' || a === 'scrollUp') {
        if (s.count < MAX_DRAFTS) void requestDraft(s.item)
      } else if (a === 'back') {
        setState({ name: 'detail', item: s.item, page: 0 })
      }
      return
    }
    case 'sent':
      if (a === 'tap' || a === 'back') void loadDigest()
      return
  }
}

function onVoice(action: VoiceAction): void {
  if (!action) return
  const s = state
  if (action === 'send') {
    if (s.name === 'draft') void doSend(s.item, s.draft, s.count)
    else if (s.name === 'detail') void requestDraft(s.item)
  } else if (action === 'shorter') {
    if (s.name === 'draft' && s.count < MAX_DRAFTS) {
      void requestDraft(s.item, 'shorter')
    }
  } else if (action === 'next') {
    if (s.name === 'digest') {
      const item = s.items[s.cursor]
      if (item) void skipItem(item)
    } else if (s.name === 'detail' || s.name === 'draft') {
      void skipItem(s.item)
    } else if (s.name === 'sent') {
      void loadDigest()
    }
  }
}

// ------------------------------------------------------------ boot + dev bar

async function boot(): Promise<void> {
  const screenEl = document.getElementById('screen')
  if (!screenEl) return
  const dom = new DomRenderer(screenEl)
  renderers.push(dom)
  const bridge = await BridgeRenderer.tryCreate()
  if (bridge) {
    renderers.push(bridge)
    console.info('[balas-kilat] Even Hub bridge connected')
  }
  renderers.forEach((r) => r.onInput(onInput))
  buildDevBar()
  render()
  void loadDigest()
}

function buildDevBar(): void {
  const hint = document.getElementById('hint')
  if (!hint) return
  hint.innerHTML = `
    <button data-act="tap">Tap</button>
    <button data-act="scrollUp">▲</button>
    <button data-act="scrollDown">▼</button>
    <button data-act="back">2×Tap / Back</button>
    <span class="sep"></span>
    <input id="voiceIn" type="text" placeholder='voice: kirim / lebih singkat / lanjut' />
    <button id="voiceSay">Say</button>
    <button id="voiceMic">🎙</button>
    <span class="sep"></span>
    <a href="?mock=1">demo data</a> · <a href="?">live backend</a>
    <span id="voiceStatus"></span>`
  hint.querySelectorAll<HTMLButtonElement>('button[data-act]').forEach((b) => {
    b.addEventListener('click', () =>
      onInput(b.dataset.act as InputAction),
    )
  })
  const status = hint.querySelector<HTMLElement>('#voiceStatus')
  const say = () => {
    const input = hint.querySelector<HTMLInputElement>('#voiceIn')
    const text = input?.value ?? ''
    const action = matchVoicePhrase(text)
    if (status) status.textContent = text ? `voice: "${text}" → ${action ?? '—'}` : ''
    onVoice(action)
  }
  hint.querySelector('#voiceSay')?.addEventListener('click', say)
  hint.querySelector('#voiceMic')?.addEventListener('click', () => {
    const ok = listenOnce((text) => {
      const action = matchVoicePhrase(text)
      if (status) status.textContent = `heard: "${text}" → ${action ?? '—'}`
      onVoice(action)
    })
    if (!ok && status) status.textContent = 'voice: speech recognition unavailable here'
  })
}

void boot()
