import type { EncodedPart } from '../../../core/communication/communication-contract'
export const TELEGRAM_PART_UNITS = 4000
function windowEnd(text: string, start = 0): number {
  let end = Math.min(start + TELEGRAM_PART_UNITS, text.length)
  if (end < text.length && /[\uD800-\uDBFF]/u.test(text[end - 1])) end--
  return end
}
export function encodeTelegramText(text: string): EncodedPart[] {
  const parts: EncodedPart[] = []
  while (text.length) {
    let end = windowEnd(text)
    if (end < text.length) {
      const window = text.slice(0, end)
      const newline = window.lastIndexOf('\n')
      const whitespace = [...window.matchAll(/\s/gu)].at(-1)?.index ?? -1
      // Every part needs a body, including the next window. Reserving the last
      // code point with a body lets trailing or long interior whitespace fit
      // without dropping text or creating a whitespace-only message.
      const lastBody = [...window.matchAll(/\S/gu)].at(-1)?.index ?? 0
      const boundary = [newline + 1, whitespace + 1, end, lastBody].find(
        (cut) =>
          cut > 0 &&
          /\S/u.test(text.slice(0, cut)) &&
          /\S/u.test(text.slice(cut, windowEnd(text, cut)))
      )
      if (boundary === undefined) throw new Error('Telegram text cannot fit nonblank parts')
      end = boundary
    }
    const part = text.slice(0, end)
    if (!/\S/u.test(part)) throw new Error('Telegram text cannot fit nonblank parts')
    parts.push({ text: part, format: 'plain' })
    text = text.slice(end)
  }
  return parts
}
