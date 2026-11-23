// Glasses text discipline: <= 30 chars per line, <= 7 lines per screen.

export const LINE = 30
export const SCREEN_LINES = 7

/** Word-wrap text to at most `width` chars per line. */
export function wrap(text: string, width: number = LINE): string[] {
  const words = text.replace(/\s+/g, ' ').trim().split(' ').filter(Boolean)
  const lines: string[] = []
  let cur = ''
  for (const w of words) {
    if (w.length > width) {
      if (cur) lines.push(cur)
      for (let i = 0; i < w.length; i += width) lines.push(w.slice(i, i + width))
      cur = ''
    } else if (!cur) {
      cur = w
    } else if (cur.length + 1 + w.length <= width) {
      cur += ' ' + w
    } else {
      lines.push(cur)
      cur = w
    }
  }
  if (cur) lines.push(cur)
  return lines.length ? lines : ['']
}

/** Truncate to one line of at most `width` chars, at a word boundary. */
export function oneLine(text: string, width: number = LINE): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  if (flat.length <= width) return flat
  const slice = flat.slice(0, width - 1)
  const lastSpace = slice.lastIndexOf(' ')
  return (lastSpace > 8 ? slice.slice(0, lastSpace) : slice).trimEnd() + '…'
}

/** Split lines into pages of `per` lines. */
export function paginate(lines: string[], per: number): string[][] {
  const pages: string[][] = []
  for (let i = 0; i < lines.length; i += per) pages.push(lines.slice(i, i + per))
  return pages.length ? pages : [[]]
}
