// Balas Kilat API layer: talks to the backend's /digest /draft /send /skip.
// A MockApi with the same interface ships in the bundle so the UI runs
// standalone (open the app with ?mock=1) with no backend at all.

export interface DigestItem {
  id: string
  chat: string
  sender: string
  time: string
  summary: string
  text: string
}

export interface Digest {
  mode: string
  count: number
  items: DigestItem[]
}

export interface DraftResult {
  draft: string
  draftCount: number
  source: string
}

export interface Api {
  digest(): Promise<Digest>
  draft(messageId: string, instruction?: string): Promise<DraftResult>
  send(messageId: string, text: string): Promise<{ to: string; chat: string }>
  skip(messageId: string): Promise<void>
}

const API_BASE: string =
  (import.meta as unknown as { env?: Record<string, string> }).env
    ?.VITE_API_BASE ?? ''

async function call<T>(
  path: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<T> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(API_BASE + path, {
      ...init,
      signal: ctrl.signal,
      headers: { 'Content-Type': 'application/json' },
    })
    const body = (await res.json()) as T & { ok?: boolean; error?: string }
    if (!res.ok || (body as { ok?: boolean }).ok === false) {
      throw new Error((body as { error?: string }).error || `HTTP ${res.status}`)
    }
    return body
  } finally {
    clearTimeout(timer)
  }
}

export class HttpApi implements Api {
  // The backend may call the LLM relay for >200-char summaries and for
  // drafts; both can take a while, so timeouts are generous.
  digest(): Promise<Digest> {
    return call<Digest>('/digest', { method: 'GET' }, 30_000)
  }
  draft(messageId: string, instruction?: string): Promise<DraftResult> {
    return call<DraftResult>(
      '/draft',
      { method: 'POST', body: JSON.stringify({ messageId, instruction }) },
      60_000,
    )
  }
  async send(messageId: string, text: string): Promise<{ to: string; chat: string }> {
    const r = await call<{ to: string; chat: string }>(
      '/send',
      { method: 'POST', body: JSON.stringify({ messageId, text }) },
      25_000,
    )
    return { to: r.to, chat: r.chat }
  }
  async skip(messageId: string): Promise<void> {
    await call('/skip', {
      method: 'POST',
      body: JSON.stringify({ messageId }),
    }, 10_000)
  }
}

// ---------------------------------------------------------------- mock api

const MOCK_ITEMS: DigestItem[] = [
  {
    id: 'mock-4', chat: 'Sinka', sender: 'Sinka', time: '08:03',
    summary: 'gas claim jam 7? gue udah siapin wallet',
    text: 'gas claim jam 7? gue udah siapin wallet',
  },
  {
    id: 'mock-3', chat: 'airdrop finder', sender: 'Rafi', time: '07:48',
    summary: 'WL mint opens tonight, snapshot in 1 hour…',
    text: 'WL mint opens tonight, snapshot in 1 hour. Make sure your wallet is registered.',
  },
  {
    id: 'mock-2', chat: 'Nosana Builders', sender: 'Dhea', time: '07:34',
    summary: 'deploy gagal lagi, kayaknya RPC-nya down…',
    text: 'deploy gagal lagi, kayaknya RPC-nya down. ada yang bisa cek?',
  },
  {
    id: 'mock-0', chat: 'Keluarga', sender: 'Bunda', time: '06:32',
    summary: 'Jangan lupa hari Minggu kita kumpul…',
    text: 'Jangan lupa hari Minggu kita kumpul di rumah nenek jam 10 ya, tolong kabari kakakmu juga',
  },
]

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms))

export class MockApi implements Api {
  private items: DigestItem[] = [...MOCK_ITEMS]
  private counts = new Map<string, number>()

  async digest(): Promise<Digest> {
    await delay(250)
    return { mode: 'mock-local', count: this.items.length, items: [...this.items] }
  }

  async draft(messageId: string, instruction?: string): Promise<DraftResult> {
    await delay(600)
    const item = this.items.find((i) => i.id === messageId)
    if (!item) throw new Error('message not found')
    const n = (this.counts.get(messageId) ?? 0) + 1
    this.counts.set(messageId, n)
    const idn = /gue|udah|jam|bisa|makasih|nanti|kita/i.test(item.text)
    let draft: string
    if (instruction === 'shorter') {
      draft = idn ? 'Siap, aku cek dulu ya.' : 'Got it — checking now.'
    } else if (item.text.includes('?')) {
      draft = idn
        ? 'Oke, aku cek dulu ya — nanti aku kabari lagi.'
        : "Let me check first — I'll confirm shortly."
    } else {
      draft = idn ? 'Siap, makasih infonya!' : 'Got it, thanks for the heads-up!'
    }
    return { draft, draftCount: n, source: 'mock-template' }
  }

  async send(messageId: string, text: string): Promise<{ to: string; chat: string }> {
    await delay(300)
    const item = this.items.find((i) => i.id === messageId)
    if (!item) throw new Error('message not found')
    console.log('[mock send]', item.chat, '/', item.sender, ':', text)
    this.items = this.items.filter((i) => i.id !== messageId)
    return { to: item.sender, chat: item.chat }
  }

  async skip(messageId: string): Promise<void> {
    this.items = this.items.filter((i) => i.id !== messageId)
  }
}

export function pickApi(): Api {
  const params = new URLSearchParams(location.search)
  return params.get('mock') === '1' ? new MockApi() : new HttpApi()
}
