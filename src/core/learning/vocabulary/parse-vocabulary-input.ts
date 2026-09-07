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
export function parseVocabularyInput(text: string): VocabularyInputItem[] {
  if (text.length > 4000) throw new VocabularyError('INVALID_INPUT')
  const terms = text
    .split(/[,，]/)
    .map((term) => term.trim())
    .filter(Boolean)
  if (!terms.length || terms.length > 20) throw new VocabularyError('INVALID_INPUT')
  const seen = new Map<string, number>()
  return terms.map((term, inputIndex) => {
    const lookupKey = term.normalize('NFC').trim().replace(/\s+/gu, ' ')
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
