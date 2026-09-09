import { SYNONYM_MAX_LENGTH, type SynonymErrorCode } from '../../../shared/synonym'

export class SynonymError extends Error {
  constructor(
    readonly code: SynonymErrorCode,
    options?: ErrorOptions
  ) {
    super(`Synonym operation failed: ${code}`, options)
  }
}

export interface SynonymInputItem {
  inputIndex: number
  input: string
  word: string
  sourceInputIndex?: number
}

export function normalizeSynonym(word: string): string {
  return word.normalize('NFC').trim().replace(/\s+/gu, ' ').toLowerCase()
}

export function parseSynonymInput(text: string): SynonymInputItem[] {
  if (text.length > 4000) throw new SynonymError('INVALID_INPUT')
  const lines = text.split(/[,，]/u)
  const seen = new Map<string, number>()
  const items: SynonymInputItem[] = []
  for (const line of lines) {
    const input = line
    if (!input.trim()) continue
    const synonym = normalizeSynonym(input)
    if (!synonym || synonym.length > SYNONYM_MAX_LENGTH) throw new SynonymError('INVALID_INPUT')
    const inputIndex = items.length
    const sourceInputIndex = seen.get(synonym)
    if (sourceInputIndex === undefined) seen.set(synonym, inputIndex)
    items.push({
      inputIndex,
      input,
      word: synonym,
      ...(sourceInputIndex === undefined ? {} : { sourceInputIndex })
    })
    if (items.length > 20) throw new SynonymError('INVALID_INPUT')
  }
  if (!items.length) throw new SynonymError('INVALID_INPUT')
  return items
}
