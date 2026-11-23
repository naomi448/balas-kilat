#!/usr/bin/env python3
"""Balas Kilat backend.

Telegram Bot API ingress (long-polling) -> in-memory queue -> digest /
draft / send endpoints for the Even Realities G2 app.

Design rules (see ../README.md and the design doc):
- Opt-in chats only: the bot only ever sees chats it was added to, plus
  messages forwarded to it.
- Nothing is written to disk. Queue items drop once answered or skipped.
- Secrets live only in this process's environment. The bot token is read
  from TELEGRAM_BOT_TOKEN; when it is absent the backend runs in full
  MOCK mode (seeded incoming messages, sends are only logged) so the
  whole loop is testable without any credential.
- /send performs exactly one Bot API call. No retries on ambiguity: an
  error is surfaced to the caller instead.

Stdlib only (Python 3.12). Run:  python3 server.py
Env: TELEGRAM_BOT_TOKEN (optional), TELEGRAM_VIA_CONNECTOR=1 (optional;
     live mode through the custom.telegram-bot vault connector when no
     direct token is set), PORT (default 8787),
     HMS_HELPER (path to the 100milionseek relay helper hms.py).
"""

import json
import os
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

# ---------------------------------------------------------------- config

TOKEN = os.environ.get("TELEGRAM_BOT_TOKEN", "").strip()

# Live-via-connector mode: when TELEGRAM_VIA_CONNECTOR=1 and no direct
# token is set, Bot API URLs carry the vault connector's RAW surrogate
# in the path (never the real token); the egress layer swaps in the real
# credential for requests to api.telegram.org. This mirrors the verified
# approach in custom-connectors/custom.telegram-bot/bin/tg.py — do NOT
# use url_with_surrogate_path_segment (it URL-quotes the surrogate and
# the swap misses). The surrogate value is never printed or logged.
CONNECTOR_NAME = "custom.telegram-bot"
_dynamic_credential_entry = None
if os.environ.get("TELEGRAM_VIA_CONNECTOR", "").strip() == "1" and not TOKEN:
    _dc_bin = "/opt/muse/skills/custom-connector-setup/bin"
    if _dc_bin not in sys.path:
        sys.path.insert(0, _dc_bin)
    try:
        from dynamic_credentials import dynamic_credential_entry as _dce
        _dynamic_credential_entry = _dce
    except Exception as _exc:  # connector unavailable: stay in mock mode
        print(f"[boot] connector import failed ({_exc}); "
              "TELEGRAM_VIA_CONNECTOR ignored", flush=True)
VIA_CONNECTOR = _dynamic_credential_entry is not None
MODE = "live-connector" if VIA_CONNECTOR else ("live" if TOKEN else "mock")
MOCK_MODE = MODE == "mock"
PORT = int(os.environ.get("PORT", "8787"))
HMS_HELPER = os.environ.get(
    "HMS_HELPER",
    str(Path.home() / "workspace/custom-connectors/custom.100milionseek/bin/hms.py"),
)
RELAY_TIMEOUT = int(os.environ.get("RELAY_TIMEOUT", "45"))
TG_API = "https://api.telegram.org/bot" + TOKEN
APP_DIST = Path(__file__).resolve().parent.parent / "app" / "dist"

MAX_DRAFT_CHARS = 240
DIGEST_SIZE = 5
SUMMARY_CHARS = 64

# Draft-prompt spec, verbatim from the design doc (section 4).
DRAFT_SYSTEM = (
    "You draft very short Telegram replies for the user to approve. "
    "Match the language of the incoming message (Indonesian or English). "
    "Casual, warm, max 2 short sentences. Never invent facts, times, prices "
    "or commitments that are not in the message. If the message asks a "
    "question you cannot answer from context, draft a polite holding reply "
    "asking to confirm later."
)
INSTRUCTION_MAP = {
    "shorter": "Rewrite in under 12 words.",
    "lebih singkat": "Rewrite in under 12 words.",
    "formal": "Rewrite politely and formally.",
}

# ---------------------------------------------------------------- queue

_lock = threading.Lock()
_queue: list[dict] = []          # newest last internally; served newest first
_draft_counts: dict[str, int] = {}
_sent_log: list[dict] = []       # mock-mode record of sends (memory only)


def log(*parts):
    ts = datetime.now(timezone.utc).strftime("%H:%M:%S")
    print(f"[{ts}]", *parts, flush=True)


def enqueue(item: dict) -> None:
    with _lock:
        if any(q["key"] == item["key"] for q in _queue):
            return
        _queue.append(item)
    log("queued:", item["sender"], "—", item["text"][:60].replace("\n", " "))


def find_item(message_id: str):
    with _lock:
        for q in _queue:
            if q["id"] == message_id:
                return q
    return None


def drop_item(message_id: str) -> bool:
    with _lock:
        before = len(_queue)
        _queue[:] = [q for q in _queue if q["id"] != message_id]
        _draft_counts.pop(message_id, None)
        return len(_queue) != before


def seed_mock_queue() -> None:
    now = int(time.time())
    # Chronological order (oldest first), like real polling delivers them.
    seeds = [
        # (chat, sender, text, minutes_ago)
        ("Keluarga", "Bunda",
         "Jangan lupa hari Minggu kita kumpul di rumah nenek jam 10 ya, "
         "tolong kabari kakakmu juga", 95),
        ("Devpost Updates", "Devpost",
         "Hello builders! This is a reminder that the submission window "
         "for this week's featured hackathons closes soon. Please make "
         "sure your project page includes a public repository link, a "
         "demo video of at most three minutes, and a short description "
         "of the problem, who it is for, and how it works. Projects "
         "missing any of these will not be reviewed by the judges, so "
         "double-check everything before the deadline tonight.", 61),
        ("Nosana Builders", "Dhea",
         "deploy gagal lagi, kayaknya RPC-nya down. ada yang bisa cek?", 33),
        ("airdrop finder", "Rafi",
         "WL mint opens tonight, snapshot in 1 hour. Make sure your "
         "wallet is registered.", 19),
        ("Sinka", "Sinka",
         "gas claim jam 7? gue udah siapin wallet", 4),
    ]
    for i, (chat, sender, text, mins) in enumerate(seeds):
        ts = now - mins * 60
        enqueue({
            "key": f"mock-{i}",
            "id": f"mock-{i}",
            "chatId": f"mock-chat-{i}",
            "chat": chat,
            "sender": sender,
            "text": text,
            "ts": ts,
            "tgMessageId": None,
        })
    log(f"MOCK mode: seeded {len(seeds)} incoming messages")


# ---------------------------------------------------------------- text utils

def truncate_words(text: str, limit: int) -> str:
    text = " ".join(text.split())
    if len(text) <= limit:
        return text
    cut = text[:limit].rsplit(" ", 1)[0].rstrip(",.;:")
    return (cut or text[:limit]) + "…"


_ID_MARKERS = {
    "yang", "gue", "udah", "jam", "bisa", "ada", "nggak", "gak", "makasih",
    "siap", "nanti", "kita", "aku", "saya", "tolong", "jangan", "lagi",
    "kayaknya", "banget", "ya", "di", "ke", "dan", "untuk", "dengan",
}


def looks_indonesian(text: str) -> bool:
    words = {w.strip(".,!?\"'").lower() for w in text.split()}
    return len(words & _ID_MARKERS) >= 2


# ---------------------------------------------------------------- relay (LLM)

def relay_chat(prompt: str, max_tokens: int = 160) -> str | None:
    """One chat completion via the 100milionseek helper. None on any failure."""
    try:
        proc = subprocess.run(
            [sys.executable, HMS_HELPER, "chat", prompt, str(max_tokens)],
            capture_output=True, text=True, timeout=RELAY_TIMEOUT,
        )
    except (subprocess.TimeoutExpired, OSError) as exc:
        log("relay call failed:", exc)
        return None
    out = proc.stdout or ""
    brace = out.find("{")
    if proc.returncode != 0 or brace < 0:
        log("relay bad response, rc =", proc.returncode)
        return None
    try:
        body = json.loads(out[brace:])
        content = body["choices"][0]["message"]["content"]
    except (ValueError, KeyError, IndexError, TypeError):
        log("relay unparsable response")
        return None
    content = " ".join(str(content).split()).strip().strip('"')
    return content or None


def one_line_summary(text: str) -> str:
    """Digest one-liner: truncate at a word boundary; LLM summary only
    when the message is longer than 200 chars (design doc rule)."""
    flat = " ".join(text.split())
    if len(flat) <= 200:
        return truncate_words(flat, SUMMARY_CHARS)
    prompt = (
        "Summarize this Telegram message in ONE very short line, "
        "at most 10 words, in the same language as the message. "
        "Reply with only the summary.\n\nMessage:\n" + flat[:800]
    )
    summary = relay_chat(prompt, max_tokens=60)
    if summary:
        return truncate_words(summary, SUMMARY_CHARS + 16)
    return truncate_words(flat, SUMMARY_CHARS)


# ---------------------------------------------------------------- drafting

def template_draft(item: dict, instruction: str | None) -> str:
    """Deterministic fallback so /draft never hard-fails."""
    text = item["text"]
    idn = looks_indonesian(text)
    instr = (instruction or "").strip().lower()
    if instr in ("shorter", "lebih singkat"):
        return "Siap, aku cek dulu ya." if idn else "Got it — checking now."
    if instr == "formal":
        return ("Baik, terima kasih atas informasinya. "
                "Saya akan segera menindaklanjutinya.") if idn else \
               ("Thank you for the update. "
                "I will follow up on this shortly.")
    if "?" in text:
        return ("Oke, aku cek dulu ya — nanti aku kabari lagi.") if idn else \
               "Let me check first — I'll confirm with you shortly."
    return ("Siap, makasih infonya!") if idn else "Got it, thanks for the heads-up!"


def make_draft(item: dict, instruction: str | None) -> tuple[str, str]:
    """Returns (draft, source) where source is 'relay' or 'template'."""
    mapped = None
    if instruction:
        mapped = INSTRUCTION_MAP.get(instruction.strip().lower(), instruction.strip())
    parts = [DRAFT_SYSTEM, ""]
    if mapped:
        parts.append("Regenerate instruction: " + mapped)
    parts.append(
        f'Incoming message (from {item["sender"]} in chat "{item["chat"]}"):'
    )
    parts.append('"""' + item["text"][:600] + '"""')
    parts.append("Reply with ONLY the draft reply text, nothing else.")
    draft = relay_chat("\n".join(parts), max_tokens=160)
    if draft:
        return truncate_words(draft, MAX_DRAFT_CHARS), "relay"
    return template_draft(item, instruction), "template"


# ---------------------------------------------------------------- telegram

class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args):
        raise RuntimeError("redirect refused, verify the endpoint")


_TG_OPENER = urllib.request.build_opener(_NoRedirect())


def tg_url(method: str) -> str:
    """Bot API URL for the active transport. In connector mode the path
    segment is the raw surrogate (see config note); the URL itself is
    never logged."""
    if VIA_CONNECTOR:
        surrogate = str(
            _dynamic_credential_entry(CONNECTOR_NAME, "access_token")["surrogate"]
        ).strip()
        return "https://api.telegram.org/bot" + surrogate + "/" + method
    return f"{TG_API}/{method}"


def tg_call(method: str, payload: dict, timeout: int = 35) -> dict:
    req = urllib.request.Request(
        tg_url(method),
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with _TG_OPENER.open(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def poll_loop() -> None:
    """Long-polling ingress (real mode only). Runs in a daemon thread."""
    offset = 0
    log("telegram long-polling started")
    while True:
        try:
            body = tg_call("getUpdates",
                           {"offset": offset, "timeout": 30,
                            "allowed_updates": ["message", "channel_post"]},
                           timeout=40)
            for upd in body.get("result", []):
                offset = upd["update_id"] + 1
                msg = upd.get("message") or upd.get("channel_post") or {}
                text = (msg.get("text") or "").strip()
                if not text:
                    continue
                chat = msg.get("chat", {})
                frm = msg.get("from", {})
                sender = (frm.get("first_name")
                          or chat.get("title")
                          or chat.get("username") or "Unknown")
                enqueue({
                    "key": f"{chat.get('id')}:{msg.get('message_id')}",
                    "id": f"{chat.get('id')}:{msg.get('message_id')}",
                    "chatId": chat.get("id"),
                    "chat": chat.get("title") or chat.get("first_name")
                            or chat.get("username") or str(chat.get("id")),
                    "sender": sender,
                    "text": text,
                    "ts": msg.get("date", int(time.time())),
                    "tgMessageId": msg.get("message_id"),
                })
        except Exception as exc:  # keep polling; ingress must be resilient
            log("poll error:", exc)
            time.sleep(3)


def send_reply(item: dict, text: str) -> tuple[bool, str]:
    """Exactly one send attempt. Returns (ok, detail)."""
    if MOCK_MODE:
        record = {"to": item["sender"], "chat": item["chat"],
                  "text": text, "at": int(time.time())}
        _sent_log.append(record)
        log("MOCK SEND →", item["chat"], "/", item["sender"], ":", text)
        return True, "mock"
    payload = {"chat_id": item["chatId"], "text": text}
    if item.get("tgMessageId"):
        payload["reply_to_message_id"] = item["tgMessageId"]
    try:
        body = tg_call("sendMessage", payload, timeout=20)
    except urllib.error.HTTPError as exc:
        return False, f"telegram HTTP {exc.code}: {exc.read().decode('utf-8', 'replace')[:200]}"
    except Exception as exc:
        return False, f"telegram error: {exc}"
    if not body.get("ok"):
        return False, f"telegram not ok: {str(body)[:200]}"
    return True, "telegram"


# ---------------------------------------------------------------- http api

class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):  # quieter logs
        log("http:", fmt % args)

    # -- helpers
    def _json(self, code: int, obj: dict) -> None:
        data = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(data)

    def _body(self) -> dict:
        length = int(self.headers.get("Content-Length") or 0)
        if not length:
            return {}
        try:
            return json.loads(self.rfile.read(length).decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            return {}

    # -- routes
    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self):
        path = self.path.split("?", 1)[0]
        if path == "/health":
            with _lock:
                n = len(_queue)
            return self._json(200, {"ok": True,
                                    "mode": "mock" if MOCK_MODE else "live",
                                    "transport": ("connector" if VIA_CONNECTOR
                                                  else "token" if TOKEN
                                                  else "mock"),
                                    "queued": n})
        if path == "/digest":
            with _lock:
                items = list(reversed(_queue))[:DIGEST_SIZE]
                total = len(_queue)
            out = []
            for it in items:
                out.append({
                    "id": it["id"],
                    "chat": it["chat"],
                    "sender": it["sender"],
                    "time": datetime.fromtimestamp(it["ts"]).strftime("%H:%M"),
                    "ts": it["ts"],
                    "summary": one_line_summary(it["text"]),
                    "text": it["text"],
                })
            return self._json(200, {"mode": "mock" if MOCK_MODE else "live",
                                    "count": total, "items": out})
        return self._static(path)

    def do_POST(self):
        path = self.path.split("?", 1)[0]
        body = self._body()
        if path == "/draft":
            item = find_item(str(body.get("messageId", "")))
            if not item:
                return self._json(404, {"ok": False, "error": "message not found"})
            instruction = body.get("instruction")
            draft, source = make_draft(item, str(instruction) if instruction else None)
            with _lock:
                n = _draft_counts.get(item["id"], 0) + 1
                _draft_counts[item["id"]] = n
            return self._json(200, {"ok": True, "messageId": item["id"],
                                    "draft": draft, "draftCount": n,
                                    "source": source})
        if path == "/send":
            item = find_item(str(body.get("messageId", "")))
            text = str(body.get("text", "")).strip()
            if not item:
                return self._json(404, {"ok": False, "error": "message not found"})
            if not text:
                return self._json(400, {"ok": False, "error": "empty text"})
            ok, detail = send_reply(item, text[:MAX_DRAFT_CHARS * 4])
            if not ok:
                return self._json(502, {"ok": False, "error": detail})
            drop_item(item["id"])
            return self._json(200, {"ok": True, "via": detail,
                                    "to": item["sender"], "chat": item["chat"]})
        if path == "/skip":
            gone = drop_item(str(body.get("messageId", "")))
            return self._json(200 if gone else 404,
                              {"ok": gone, "error": None if gone else "message not found"})
        return self._json(404, {"ok": False, "error": "no such route"})

    # -- static app (built G2 web app, if present)
    def _static(self, path: str) -> None:
        if not APP_DIST.is_dir():
            return self._json(200, {
                "app": "balas-kilat backend",
                "mode": "mock" if MOCK_MODE else "live",
                "note": "app/dist not built yet; API is live, or run the "
                        "Vite dev server in ../app",
                "endpoints": ["/health", "/digest", "POST /draft",
                              "POST /send", "POST /skip"],
            })
        rel = "index.html" if path in ("/", "") else path.lstrip("/")
        target = (APP_DIST / rel).resolve()
        if not str(target).startswith(str(APP_DIST.resolve())) or not target.is_file():
            target = APP_DIST / "index.html"
        data = target.read_bytes()
        ctype = {".html": "text/html; charset=utf-8",
                 ".js": "text/javascript", ".css": "text/css",
                 ".json": "application/json", ".svg": "image/svg+xml",
                 ".png": "image/png", ".ico": "image/x-icon"}.get(
                     target.suffix, "application/octet-stream")
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


def main() -> None:
    if MOCK_MODE:
        seed_mock_queue()
    else:
        threading.Thread(target=poll_loop, daemon=True).start()
    server = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    log(f"balas-kilat backend on :{PORT} ({MODE} mode)")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
