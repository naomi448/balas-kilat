# Balas Kilat — Build Log

## Day 1 — Mon 23 Nov 2026 (build window opened 15:00 WIB)

Built the full MVP loop end to end on this VM: backend + G2 app,
verified in MOCK mode (no real bot token yet — Yan's token handover via
the secure vault flow runs in parallel; the backend needs nothing else
to go live).

### What was built

**Backend** — `backend/server.py`, Python 3.12, **stdlib only**:
- Telegram Bot API long-polling ingress (real mode) into an in-memory
  queue (chat, sender, text, timestamp, message id; dedup by
  chat+message id; nothing written to disk; items drop once
  answered/skipped).
- `GET /digest` — top 5, newest first, one-line summaries (truncate at
  word boundary; LLM summary via the relay only when a message is
  > 200 chars, per the design rule).
- `POST /draft {messageId, instruction?}` — draft-prompt spec from the
  design doc used verbatim (match ID/EN, casual-short, max ~240 chars,
  never invent facts; "shorter" → "Rewrite in under 12 words.", etc.).
  Drafting calls the free relay first (100milionseek helper `hms.py`,
  model `deepseek-v4.1-flash-free`); on any relay failure it falls back
  to a deterministic language-matched template, so /draft never
  hard-fails. Per-message draft counts are tracked (app caps at 3).
- `POST /send {messageId, text}` — one Bot API `sendMessage` as a reply
  to the original message; **no retries**; errors returned to the app.
- `POST /skip {messageId}`, `GET /health`; serves `app/dist` statically
  when built (single-process demo), CORS open for the dev split.
- **MOCK mode** (no `TELEGRAM_BOT_TOKEN` in env): 5 seeded incoming
  messages (incl. the design doc's Sinka example and one >200-char
  message to exercise LLM summaries); sends are logged, not sent.

**G2 app** — `app/`, Vite + TypeScript, official SDK packages:
- `@evenrealities/even_hub_sdk` 0.0.16, `@evenrealities/evenhub-cli`
  0.2.0, `@evenrealities/evenhub-simulator` 0.9.5 (devDependency) —
  **all three package names from the stage-1 doc resolved exactly; no
  discrepancy.**
- Screens S0 (empty), S1 (digest, scroll cursor over 2-line items),
  S2 (detail, paginated), S3 (draft + confirm: tap = send, swipe =
  new draft max 3), S4 (sent), plus the one-line error state with
  tap-to-retry. All screens ≤ 30 chars/line, ≤ 7 lines, one idea +
  one action, 576×288 green monochrome.
- Two renderers over one screen model: a DOM renderer (browser/dev)
  and an Even Hub **bridge renderer** (single full-screen
  `TextContainerProperty`, created via `createStartUpPageContainer`,
  updated via `rebuildPageContainer`; OS click / double-click /
  scroll-top / scroll-bottom events map to tap / back / scroll).
  Input: tap/click, wheel, touch swipe, keyboard; dev bar with
  buttons + voice-phrase tester for laptop work.
- Voice phrases ("send/kirim", "shorter/lebih singkat",
  "next/lanjut") matched in `voice.ts`, wired to Web Speech
  recognition where a browser provides it; tap always works.
- `app/app.json` written in the exact `evenhub init` schema
  (package_id `com.balaskilat.app`, edition 202601); the `network`
  permission whitelists the backend origin (localhost:8787 +
  dev :5173 — replace with the deployed origin before packing).
- Built-in `MockApi` (`?mock=1`) so the UI runs standalone.

### Smoke verification (actually run, 23 Nov)

| Check | Result |
|---|---|
| Relay helper `hms.py models` | HTTP 200, `deepseek-v4.1-flash-free` listed |
| Backend start (mock) | ✅ `{"ok": true, "mode": "mock", "queued": 5}` |
| `GET /digest` | ✅ 5 seeded items, newest first; the >200-char message got a relay one-line summary ("Hackathon submissions close tonight; ensure repo, demo, description included.") |
| `POST /draft` (Indonesian msg) | ✅ source=**relay**: "Siap, wallet lo aman! Gue cek dulu ya soal jam 7-nya, nanti gue kabarin" — language-matched, holding-style, no invented commitment |
| `POST /draft` + instruction "shorter" | ✅ source=relay, shorter draft returned, draftCount increments |
| `POST /draft` (English msg) | ✅ source=relay, English draft |
| `POST /draft` with relay helper path broken | ✅ source=**template**, HTTP 200 (ID + EN templates correct) — /draft never hard-fails |
| `POST /send` (mock) | ✅ `{"ok": true, "via": "mock"}`, log line `MOCK SEND → Sinka / Sinka : …`, item dropped (queue 5 → 3 after send + skip) |
| `POST /skip`, unknown-id send | ✅ skip ok; unknown id → 404 `message not found` |
| `npm install` | ✅ 15 packages, ~18 s |
| `npm run build` | ✅ `tsc --noEmit` clean + Vite build (dist ~94 KB JS) |
| Backend serves `app/dist` | ✅ `GET /` returns the app, assets 200 |
| Vite dev server + API proxy | ✅ HTTP 200; `/health` via :5173 proxied to backend |
| GUI simulator | ⏭️ **not attempted** — headless VM; known stage-2 check for Yan's laptop |

Notes: relay draft calls took ~10–15 s each in today's tests (free
relay latency); the app shows a "Drafting reply…" screen meanwhile and
timeouts are set generously (60 s). One bug found and fixed during
smoke: mock seed order vs. digest newest-first ordering.

### Design decisions worth knowing

- Bridge rendering uses ONE full-screen text container for every
  screen (instead of native list containers): total control over the
  30-char/7-line discipline and a single code path shared with the DOM
  renderer. The digest cursor is drawn with a `>` prefix; scroll
  events move it, click opens.
- Voice on real glasses hardware arrives as raw PCM via the SDK; it
  needs a backend STT endpoint (Whisper) — that is the design doc's
  stretch item and is **not** wired yet. The phrase matcher and all
  action wiring are done; only the audio→text leg is missing.

### What's left

1. **Real-token wiring** — Yan hands the bot token over via the secure
   flow; then set `TELEGRAM_BOT_TOKEN` for the backend (via the
   connector/env, never in the repo), add the bot to 1–2 test chats,
   and run the loop live.
2. **Simulator pass on Yan's laptop** (GUI) + record the demo video
   (≤ 3 min) from it — design doc §6 script.
3. **`.ehpk` pack** — `evenhub pack app.json dist` after replacing the
   app.json whitelist with the real backend origin.
4. Stretch (only if MVP is green by 26 Nov): backend STT endpoint for
   dictated replies, digest urgency header, quiet hours.
5. BUIDL submission on DoraHacks (description draft is in the design
   doc §7); internal target Fri 27–Sat 28 Nov; hard deadline
   **Mon 30 Nov 02:59 WIB**. No git commits made yet — working tree
   left for review.


---

## Update — 2026-11-23 ~15:16 WIB: LIVE mode via vault connector

**What changed** (`backend/server.py`, compile-checked):

- New transport **live-via-connector**: with `TELEGRAM_VIA_CONNECTOR=1`
  set and no `TELEGRAM_BOT_TOKEN`, the Telegram client builds Bot API
  URLs exactly like `custom-connectors/custom.telegram-bot/bin/tg.py` —
  `https://api.telegram.org/bot<RAW surrogate>/<Method>`, importing
  `dynamic_credential_entry` from
  `/opt/muse/skills/custom-connector-setup/bin`. The egress layer swaps
  the surrogate for the real token of **@Balaskilatbot** (getMe verified
  200 earlier today). The library's `url_with_surrogate_path_segment`
  is deliberately NOT used (it URL-quotes the surrogate → swap misses →
  Telegram 404). Surrogate and full URLs are never printed/logged.
- Mode selection: `MODE` is `live-connector` / `live` (direct token) /
  `mock`; MOCK stays the default when neither env is set, and direct
  `TELEGRAM_BOT_TOKEN` mode still works unchanged. `/health` now also
  reports `"transport": "connector" | "token" | "mock"`.
- `tg_call` now goes through `tg_url()` and a no-redirect opener.

**Live rig (left RUNNING for the coordinated test with Yan):**

- Started: `cd backend && TELEGRAM_VIA_CONNECTOR=1 nohup python3 server.py > live-server.log 2>&1 &`
- **PID 13485** (also in `backend/server-live.pid`), port **8787**,
  log at `backend/live-server.log`.
- Verified: `/health` → `{"ok": true, "mode": "live", "transport":
  "connector", "queued": 0}`; `/digest` count 0; log shows
  "telegram long-polling started" and **no poll errors** across a full
  30 s long-poll cycle. No Telegram message has been sent.
- Stop: `kill "$(cat backend/server-live.pid)"`.
- Restart: same start command above (mock mode = run without the env
  var; direct-token mode = set `TELEGRAM_BOT_TOKEN` instead).

## Live loop test — 2026-11-23 ~15:24 WIB
- Backend live-via-connector received Yan's 2 test messages to @Balaskilatbot into the queue.
- /draft attempt 1: relay output truncated ("Wih s"); attempt 2: relay timeout -> template fallback ("Oke, aku cek dulu ya — nanti aku kabari lagi."). Fallback behaved as designed; relay (100milionseek) was flaky this afternoon.
- /send delivered the draft via the real Bot API (ok, via=telegram); digest count dropped 2 -> 1 (answered item removed). FULL LOOP PROVEN with the real bot.

## Demo video — 2026-11-23

Deliverable: `demo/balas-kilat-demo.mp4` (64s, 1280×720, H.264, ~512 KB).

Why: Yan's laptop Xbox Game Bar is broken and his home connection is
slow, so the video was produced on this VM instead of from the Even Hub
GUI simulator on the laptop.

How it was made (honest note): the video was recorded from the app's
real web/DOM renderer — the exact same screen model the Even Hub bridge
renderer pushes to the glasses — NOT from the Even Hub GUI simulator.
The freshly built `app/dist` was served by a throwaway static server on
a scratch port (8791; the live backend on 8787 was never touched) and
driven in standalone mock mode (`?mock=1`, the app's built-in seeded
demo data) with headless Chromium via playwright-core: real clicks and
the app's own dev-bar voice input ("lebih singkat", "kirim", "lanjut")
advanced the state machine, and the `#screen` element (native 576×288)
was screenshotted at each state at 2× scale. Frames were assembled with
ffmpeg: viewport upscaled ×2 centered on the app's dark page
background, one English caption line per step, simple cuts, title and
end cards drawn with drawtext. Flow follows design doc §6 compressed:
title → digest → open message → drafting → draft → shorter draft by
voice → tap to send → sent → group message → draft → voice "kirim" to
send → remaining items skipped by voice → empty state ("All caught
up.") → end card. Capture script:
`~/workspace/tools/demo-capture/capture.mjs`; assembly:
`~/workspace/tools/demo-capture/assemble.py`; frames kept in
`demo/frames/`. Stills extracted from the finished mp4 were visually
checked: real app UI, legible, no clipped captions. No Telegram message
was sent (mock mode only).

## Simulator pass on Yan's laptop — 2026-11-23 ~15:52 WIB
- Node v26.13.1 LTS (official .msi) + `npm i -g @evenrealities/evenhub-simulator` installed cleanly.
- App pack (41 KB zip: dist + app.json + serve.mjs + PANDUAN.txt) served via `node serve.mjs` on :8080, mock mode.
- PowerShell execution policy blocked the npm .ps1 shim; fixed with `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`.
- `evenhub-simulator http://localhost:8080/?mock=1` opened the official Glasses Display rendering the Balas Kilat digest identically to the DOM view — BridgeRenderer connected. STAGE-2 SIMULATOR CHECK PASSED.

## Bridge click fix — 2026-11-23 ~15:58 WIB
- Symptom on Yan's laptop (official simulator): Up/Down moved the selection, Click did not open the message.
- Root cause: the bridge handler read eventType from only the first non-null sub-event and compared it raw against the numeric enum. Hosts may deliver eventType as a number, a string name ("CLICK_EVENT"), or a shorthand ("CLICK"), on any sub-event — scrolls arrived numeric (worked), clicks in a form the old code dropped.
- Fix in app/src/render.ts: scan textEvent/listEvent/sysEvent/top-level, normalize each eventType via the SDK's OsEventTypeList.fromJson when available plus a local number/string normalizer, then map. Rebuilt clean; laptop pack re-zipped and re-uploaded (new link, expires 25 Nov 15:59 WIB).

## Bridge click ROOT CAUSE + final fix — 2026-11-23 ~16:12 WIB
- Debug build (?debug=1 -> POST raw events to serve.mjs /log) captured the simulator's real payloads on Yan's laptop:
  - Down: textEvent {eventType:2} (SCROLL_BOTTOM)
  - Click: sysEvent {eventSource:1} — NO eventType (bare touch; eventSource 1 = TOUCH_EVENT_FROM_GLASSES_R)
  - Double Click: sysEvent {eventType:3, eventSource:1}
  - Long Press: sysEvent {eventType:9} then {eventType:10} (press + release)
- So the earlier string-format hypothesis was wrong; the single tap is simply delivered untyped by simulator 0.9.5.
- Final fix in render.ts: if no eventType is found but sysEvent.eventSource is a real input source (1/2/3), treat as tap; LONG_PRESS (9) also maps to tap. Rebuilt clean, pack re-uploaded.

## Official simulator demo video — 2026-11-23 ~16:35 WIB
- Yan recorded the Glasses Display on his laptop with Snipping Tool (after the tap fix) and sent the MP4 via chat; archived at demo/balas-kilat-demo-simulator.mp4.
- Verified from extracted frames: digest 4 unread -> Sinka detail -> Drafting -> DRAFT 1/3 (Indonesian reply) -> Sent to Sinka -> digest 3 unread -> Rafi detail (airdrop finder) -> Drafting -> DRAFT 1/3 "Got it, thanks for the heads-up!" (English, language-matched) -> Sent to Rafi -> digest 2 unread. Full loop, official simulator framing incl. button row. Duration ~43s (limit 3 min).
- This is the primary demo video for the BUIDL; the earlier web-renderer capture remains a fallback.
