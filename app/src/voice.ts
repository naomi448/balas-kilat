// Voice phrases are accelerators only — everything voice does, tap does
// too. Phrases (design doc): "send"/"kirim" = approve, "shorter"/"lebih
// singkat" = regenerate shorter, "next"/"lanjut" = skip.

export type VoiceAction = 'send' | 'shorter' | 'next' | null

export function matchVoicePhrase(raw: string): VoiceAction {
  const t = raw.toLowerCase().replace(/[.!?,]/g, ' ').replace(/\s+/g, ' ').trim()
  if (!t) return null
  if (t === 'send' || t === 'kirim' || t.endsWith(' kirim')) return 'send'
  if (t.includes('lebih singkat') || t === 'shorter' || t.endsWith(' shorter')) {
    return 'shorter'
  }
  if (t === 'next' || t === 'lanjut' || t === 'lanjutkan' || t.endsWith(' lanjut')) {
    return 'next'
  }
  return null
}

interface SpeechRecognitionLike {
  lang: string
  interimResults: boolean
  continuous: boolean
  onresult: ((ev: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null
  onend: (() => void) | null
  onerror: (() => void) | null
  start(): void
  stop(): void
}

/** Start one Web Speech recognition round (browser contexts only).
 *  Returns false when speech recognition is unavailable — voice input
 *  on the glasses themselves arrives as raw audio via the Even Hub SDK
 *  and needs a backend STT endpoint (stretch goal, not in the MVP). */
export function listenOnce(onPhrase: (text: string) => void): boolean {
  const Ctor = (
    window as unknown as {
      SpeechRecognition?: new () => SpeechRecognitionLike
      webkitSpeechRecognition?: new () => SpeechRecognitionLike
    }
  ).SpeechRecognition ??
    (window as unknown as { webkitSpeechRecognition?: new () => SpeechRecognitionLike })
      .webkitSpeechRecognition
  if (!Ctor) return false
  const rec = new Ctor()
  rec.lang = 'id-ID'
  rec.interimResults = false
  rec.continuous = false
  rec.onresult = (ev) => {
    const text = ev.results?.[0]?.[0]?.transcript ?? ''
    if (text) onPhrase(text)
  }
  try {
    rec.start()
    return true
  } catch {
    return false
  }
}
