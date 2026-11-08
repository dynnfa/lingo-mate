import type { EncodedPart, Languages } from '../../../core/communication/communication-contract'
import { message } from '../../../core/communication/reply-projection'
import { QQ_MAX_PARTS, QQ_PART_UNITS } from './qq-protocol'

export function encodeQqText(
  text: string,
  language: Languages['uiLanguage'] = 'en'
): EncodedPart[] {
  const parts: EncodedPart[] = []
  let remaining = text.toWellFormed()
  for (let index = 0; index < QQ_MAX_PARTS && remaining; index++) {
    if (remaining.length <= QQ_PART_UNITS) {
      parts.push({ text: remaining, format: 'plain' })
      break
    }
    const last = index === QQ_MAX_PARTS - 1
    const suffix = last ? '\n' + message('qqTruncated', language) : ''
    let end = QQ_PART_UNITS - suffix.length
    if (/[\uD800-\uDBFF]/u.test(remaining[end - 1])) end--
    const candidate = remaining.slice(0, end)
    const split = Math.max(candidate.lastIndexOf('\n'), candidate.search(/\s\S*$/u)) + 1
    if (split > end / 2) end = split
    parts.push({ text: remaining.slice(0, end) + suffix, format: 'plain' })
    remaining = remaining.slice(end)
  }
  return parts
}
