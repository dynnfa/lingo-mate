import type { VocabularyErrorCode } from '../../../shared/vocabulary'

export class VocabularyError extends Error {
  constructor(
    readonly code: VocabularyErrorCode,
    options?: ErrorOptions
  ) {
    super(`Vocabulary operation failed: ${code}`, options)
  }
}
export interface VocabularyInputItem {
  inputIndex: number
  term: string
  lookupKey: string
  sourceInputIndex?: number
}
// 词项查重的唯一规范化规则（NFC、去首尾空白、连续空白归一、区分大小写）。
// 词表没有 lookup_key 列，仓储在读取时对 term 现算该值。
export function normalizeLookupKey(term: string): string {
  return term.normalize('NFC').trim().replace(/\s+/gu, ' ')
}
export function parseVocabularyInput(text: string): VocabularyInputItem[] {
  if (text.length > 4000) throw new VocabularyError('INVALID_INPUT')
  const terms = text
    .split(/[,，]/)
    .map((term) => term.trim())
    .filter(Boolean)
  if (!terms.length || terms.length > 20) throw new VocabularyError('INVALID_INPUT')
  const seen = new Map<string, number>()
  return terms.map((term, inputIndex) => {
    const lookupKey = normalizeLookupKey(term)
    if (lookupKey.length > 100) throw new VocabularyError('INVALID_INPUT')
    const sourceInputIndex = seen.get(lookupKey)
    if (sourceInputIndex === undefined) seen.set(lookupKey, inputIndex)
    return {
      inputIndex,
      term,
      lookupKey,
      ...(sourceInputIndex === undefined ? {} : { sourceInputIndex })
    }
  })
}
