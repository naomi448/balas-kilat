// Screen rendering: one screen model, two renderers.
// - DomRenderer: draws the 576x288 stage into the page (browser / dev /
//   simulator webview preview).
// - BridgeRenderer: pushes the same lines to the glasses as a single
//   full-screen Even Hub text container, and turns bridge OS events
//   (click / double-click / scroll top / scroll bottom) into the same
//   input actions the DOM uses. Tap always works in both.

import {
  CreateStartUpPageContainer,
  EvenAppBridge,
  OsEventTypeList,
  RebuildPageContainer,
  TextContainerProperty,
  waitForEvenAppBridge,
} from '@evenrealities/even_hub_sdk'

export interface Screen {
  lines: string[] // <= 7 lines, each <= 30 chars
  selected?: number // index of the highlighted line (digest cursor)
}

export type InputAction = 'tap' | 'scrollDown' | 'scrollUp' | 'back'

export interface Renderer {
  show(screen: Screen): void
  onInput(cb: (a: InputAction) => void): void
}

// ---------------------------------------------------------------- DOM

export class DomRenderer implements Renderer {
  private el: HTMLElement
  private cb: ((a: InputAction) => void) | null = null
  private touchY: number | null = null

  constructor(el: HTMLElement) {
    this.el = el
    el.addEventListener('click', () => this.cb?.('tap'))
    el.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault()
        this.cb?.(e.deltaY > 0 ? 'scrollDown' : 'scrollUp')
      },
      { passive: false },
    )
    el.addEventListener('touchstart', (e) => {
      this.touchY = e.touches[0]?.clientY ?? null
    })
    el.addEventListener('touchend', (e) => {
      if (this.touchY === null) return
      const dy = (e.changedTouches[0]?.clientY ?? this.touchY) - this.touchY
      this.touchY = null
      if (Math.abs(dy) > 24) this.cb?.(dy < 0 ? 'scrollDown' : 'scrollUp')
    })
    window.addEventListener('keydown', (e) => {
      if ((e.target as HTMLElement)?.tagName === 'INPUT') return
      if (e.key === 'Enter' || e.key === ' ') this.cb?.('tap')
      else if (e.key === 'ArrowDown' || e.key === 'PageDown') this.cb?.('scrollDown')
      else if (e.key === 'ArrowUp' || e.key === 'PageUp') this.cb?.('scrollUp')
      else if (e.key === 'Escape' || e.key === 'Backspace') this.cb?.('back')
    })
  }

  onInput(cb: (a: InputAction) => void): void {
    this.cb = cb
  }

  show(screen: Screen): void {
    this.el.innerHTML = ''
    screen.lines.forEach((line, i) => {
      const div = document.createElement('div')
      div.className = 'line' + (screen.selected === i ? ' sel' : '')
      div.textContent = line === '' ? ' ' : line
      this.el.appendChild(div)
    })
  }
}

// ---------------------------------------------------------------- bridge

const CONTAINER_ID = 1

/** Normalize a host-delivered eventType (number, "CLICK_EVENT", or "CLICK")
 *  to the OsEventTypeList enum. Uses the SDK's own normalizer when present. */
function normalizeOsEventType(raw: unknown): OsEventTypeList | undefined {
  if (raw === undefined || raw === null) return undefined
  const sdkFromJson = (OsEventTypeList as unknown as {
    fromJson?: (r: unknown) => OsEventTypeList | undefined
  }).fromJson
  if (typeof sdkFromJson === 'function') {
    const v = sdkFromJson(raw)
    if (v !== undefined) return v
  }
  if (typeof raw === 'number') return raw as OsEventTypeList
  if (typeof raw === 'string') {
    const s = raw.toUpperCase()
    if (s === 'CLICK' || s === 'CLICK_EVENT') return OsEventTypeList.CLICK_EVENT
    if (s === 'DOUBLE_CLICK' || s === 'DOUBLE_CLICK_EVENT') return OsEventTypeList.DOUBLE_CLICK_EVENT
    if (s === 'SCROLL_TOP' || s === 'SCROLL_TOP_EVENT') return OsEventTypeList.SCROLL_TOP_EVENT
    if (s === 'SCROLL_BOTTOM' || s === 'SCROLL_BOTTOM_EVENT') return OsEventTypeList.SCROLL_BOTTOM_EVENT
  }
  return undefined
}

export class BridgeRenderer implements Renderer {
  private bridge: EvenAppBridge
  private cb: ((a: InputAction) => void) | null = null
  private started = false

  private constructor(bridge: EvenAppBridge) {
    this.bridge = bridge
    bridge.onEvenHubEvent((event) => {
      // Diagnostic mode (?debug=1): POST every raw bridge event to the local
      // serve.mjs /log endpoint so its console shows exactly what the host
      // delivered. Inert unless the page URL carries ?debug=1.
      if (new URLSearchParams(location.search).has('debug')) {
        try {
          void fetch('/log', {
            method: 'POST',
            body: JSON.stringify(event),
            keepalive: true,
          }).catch(() => {})
        } catch { /* diagnostics only */ }
      }
      if (!this.cb) return
      // Hosts deliver eventType inconsistently: as a PB number, as a string
      // name ("CLICK_EVENT"), or as a shorthand ("CLICK") — and it can sit on
      // any of the sub-events or the top-level event. The old code read only
      // the first non-null sub-event and compared the raw value numerically,
      // which silently dropped clicks in the Even Hub simulator (scrolls
      // arrived as numbers, clicks as strings). Scan every carrier and
      // normalize each value before comparing.
      const carriers: unknown[] = [
        event.textEvent,
        event.listEvent,
        event.sysEvent,
        event as unknown,
      ]
      let type: OsEventTypeList | undefined
      for (const c of carriers) {
        const raw = (c as { eventType?: unknown } | undefined)?.eventType
        type = normalizeOsEventType(raw)
        if (type !== undefined) break
      }
      if (type === undefined) {
        // Verified live in the official simulator (0.9.5, 2026-11-23): a
        // single tap arrives as a BARE touch sysEvent — { eventSource: 1 }
        // with no eventType at all — while double click (3) and long press
        // (9/10) do carry an eventType. A bare touch from a real input
        // source (1 = glasses R, 2 = ring, 3 = glasses L; 0 = dummy) is a tap.
        const src = (event.sysEvent as { eventSource?: unknown } | undefined)?.eventSource
        if (src === 1 || src === 2 || src === 3) this.cb('tap')
        return
      }
      if (type === OsEventTypeList.CLICK_EVENT) this.cb('tap')
      else if (type === OsEventTypeList.DOUBLE_CLICK_EVENT) this.cb('back')
      else if (type === OsEventTypeList.SCROLL_BOTTOM_EVENT) this.cb('scrollDown')
      else if (type === OsEventTypeList.SCROLL_TOP_EVENT) this.cb('scrollUp')
      else if (type === OsEventTypeList.LONG_PRESS_EVENT) this.cb('tap')
    })
  }

  /** Resolve to a BridgeRenderer when running inside the Even app /
   *  simulator (bridge answers quickly), otherwise null. */
  static async tryCreate(timeoutMs = 1500): Promise<BridgeRenderer | null> {
    try {
      const bridge = await Promise.race([
        waitForEvenAppBridge(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('no bridge')), timeoutMs),
        ),
      ])
      return new BridgeRenderer(bridge)
    } catch {
      return null
    }
  }

  onInput(cb: (a: InputAction) => void): void {
    this.cb = cb
  }

  show(screen: Screen): void {
    const content = screen.lines
      .map((l, i) => (screen.selected === i && !l.startsWith('>') ? '> ' + l : l))
      .join('\n')
    const textObject = [
      new TextContainerProperty({
        xPosition: 0,
        yPosition: 0,
        width: 576,
        height: 288,
        containerID: CONTAINER_ID,
        containerName: 'main',
        isEventCapture: 1,
        content,
      }),
    ]
    const run = this.started
      ? this.bridge.rebuildPageContainer(
          new RebuildPageContainer({ containerTotalNum: 1, textObject }),
        )
      : this.bridge.createStartUpPageContainer(
          new CreateStartUpPageContainer({ containerTotalNum: 1, textObject }),
        )
    this.started = true
    Promise.resolve(run).catch((err) => {
      console.warn('[bridge] page update failed', err)
    })
  }
}
