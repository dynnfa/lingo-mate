import type { EncodedPart } from '../../../core/communication/communication-contract'
export const TELEGRAM_PART_UNITS = 4000
export function encodeTelegramText(text: string): EncodedPart[] {
  const parts: EncodedPart[] = []
  while (text.length) {
    let end = Math.min(TELEGRAM_PART_UNITS, text.length)
    if (end < text.length) {
      if (/[\uD800-\uDBFF]/u.test(text[end - 1])) end--
      const window = text.slice(0, end)
      const newline = window.lastIndexOf('\n')
      const whitespace = [...window.matchAll(/\s/gu)].at(-1)?.index ?? -1
      const boundary = newline >= 0 ? newline : whitespace
      if (boundary >= 0) end = boundary + 1
    }
    parts.push({ text: text.slice(0, end), format: 'plain' })
    text = text.slice(end)
  }
  return parts
}
