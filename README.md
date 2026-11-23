# Balas Kilat — Telegram, glanced

**Track: 01 Messaging & News (Telegram)** — also a candidate for
⭐ Best Telegram integration. Even Realities "Heads Up" hackathon
(DoraHacks), built for the Even Realities G2.

**One-liner:** Your Telegram, glanced. AI drafts the reply, you tap once.

Important Telegram messages drown in group noise, and answering them
means pulling out your phone dozens of times a day. Balas Kilat puts a
glanceable digest of your opted-in Telegram chats on the G2 display —
sender and a one-line summary, nothing more. Open a message and an AI
agent has already drafted a short reply in the same language and tone:
**tap once to send it**, swipe for a new draft (max 3), or say a short
voice phrase ("kirim", "lebih singkat", "lanjut"). Read *and* write in
under ten seconds.

## How it works

```
Telegram chats (opt-in)          Backend (Python, stdlib only)         G2 app (Vite + TS)
─────────────────────────        ──────────────────────────────        ──────────────────
groups/channels the      ──►     Bot API long-polling ingress   ──►    S1 digest list
project bot is in,         ◄──     in-memory queue (no disk)           S2 message detail
or messages forwarded            GET  /digest  (top 5, 1-line)          S3 draft + confirm
to the bot                       POST /draft   (LLM draft reply)        S4 sent
                                 POST /send    (Bot API sendMessage)   S0 empty / error
                                 POST /skip    (drop from queue)
```

- **Digest:** top 5 queued messages, newest first, each pre-summarized
  to one line (truncate at a word boundary; an LLM summary is used only
  for messages longer than 200 characters).
- **Draft:** the backend asks an LLM for a very short reply — same
  language as the incoming message (Indonesian/English), casual, max
  ~240 chars, never inventing facts; unanswerable questions get a polite
  holding reply. If the LLM is unreachable, a deterministic template
  draft is used so drafting never hard-fails.
- **Send:** exactly one Bot API `sendMessage` call, as a reply to the
  original message. No retries on ambiguity — errors surface on the
  glasses instead.
- **App:** a thin display + input shell using the official Even Hub SDK
  (`@evenrealities/even_hub_sdk`). Inside the Even app / simulator it
  renders through the SDK bridge (one full-screen text container, OS
  click / double-click / scroll events); in a plain browser it renders
  the same screens as a 576×288 DOM stage with mouse, touch and
  keyboard input. All state lives in the backend.
- **Screens** obey the G2 discipline: ≤ 30 characters per line,
  ≤ 7 lines per screen, one idea + one action per screen, 576×288
  green monochrome. Voice phrases ("send"/"kirim",
  "shorter"/"lebih singkat", "next"/"lanjut") are accelerators only —
  tap always works.

## Setup

### Backend

```bash
cd backend
python3 server.py            # http://localhost:8787
```

Python 3.12, standard library only — nothing to install.

Environment variables (see `.env.example`):

| Variable | Meaning |
|---|---|
| `TELEGRAM_BOT_TOKEN` | Bot token from BotFather. **If unset, the backend runs in MOCK mode**: seeded fake incoming messages, sends are only logged. The full loop is testable with zero credentials. |
| `PORT` | Listen port (default `8787`). |
| `HMS_HELPER` | Path to the LLM relay helper used for drafts (defaults to the local 100milionseek connector helper). |

To go live: create a bot with BotFather, export the token (never commit
it), start the backend, and add the bot to the group chats you want in
your digest — or forward messages to it.

### G2 app

```bash
cd app
npm install
npm run dev                  # Vite dev server on :5173, API proxied to :8787
npm run build                # type-check + production build into app/dist
```

Once `app/dist` exists, the backend serves it statically at
`http://localhost:8787/` — one process is the whole demo. Open the app
with `?mock=1` to run it standalone on built-in demo data with no
backend at all.

`app/app.json` is the Even Hub manifest (created in the `evenhub init`
format). Its `network` permission whitelists the backend origin —
**change the whitelist to your deployed backend origin** before packing
an `.ehpk` with `@evenrealities/evenhub-cli` (`evenhub pack app.json dist`).

### Simulator

The Even Hub simulator (`@evenrealities/evenhub-simulator`, a
devDependency) is a desktop GUI app: run it on a laptop, point it at the
Vite dev server or the backend URL, and the full loop — digest, draft,
tap to send — runs end to end without G2 hardware.

## Data handling (plain statement)

- **Opt-in chats only.** The backend only ever sees chats the project
  bot was explicitly added to, plus messages a user forwards to the bot.
  It never reads a personal Telegram account.
- **No message storage.** Messages live in an in-memory queue only;
  nothing is written to disk, and an item is dropped as soon as it is
  answered or skipped. Restarting the backend forgets everything.
- **Keys stay server-side.** The bot token and LLM access live only in
  the backend's environment — never in the app, never in this repo.
- **Drafting** sends the message text to the backend's configured LLM
  provider for the sole purpose of drafting the reply; drafts are shown
  to the user for approval and nothing is sent without a tap.

## What existed before the build window (honesty statement)

The hackathon build window opened on **23 Nov 2026, 15:00 WIB**. All
work before that moment was research and design documents only — a
stage-1 scope/verification report and the Balas Kilat design doc
(scope, screens, backend and draft-prompt specs). **No code existed
before the build window.** Every line of code in this repository was
written during the build week.

## Layout

```
backend/server.py   the whole backend (stdlib-only Python)
app/                Vite + TypeScript G2 app (Even Hub SDK)
app/app.json        Even Hub manifest (network whitelist = backend)
app/src/api.ts      backend client + built-in mock API (?mock=1)
app/src/main.ts     screen state machine (S0–S4 + error)
app/src/render.ts   DOM renderer + Even Hub bridge renderer
app/src/voice.ts    voice-phrase matching (accelerators)
app/src/text.ts     30-char wrap / pagination helpers
BUILDLOG.md         build notes and smoke-test results
```
