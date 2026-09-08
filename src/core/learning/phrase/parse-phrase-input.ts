import { PHRASE_MAX_LENGTH, type PhraseErrorCode } from '../../../shared/phrase'

export class PhraseError extends Error {
  constructor(
    readonly code: PhraseErrorCode,
    options?: ErrorOptions
  ) {
    super(`Phrase operation failed: ${code}`, options)
  }
}

export interface PhraseInputItem {
  inputIndex: number
  // 用户原始输入行（去掉行结束符），保留在执行报告中。
  input: string
  // 本地规范化文本：作为唯一键与入库标识。
  phrase: string
  sourceInputIndex?: number
}

// 短语查重与入库的唯一规范化规则：NFC、去首尾空白、连续空白归一、区分大小写。
// 短语内部空格与逗号是内容的一部分，不做拆分。
export function normalizePhrase(phrase: string): string {
  return phrase.normalize('NFC').trim().replace(/\s+/gu, ' ')
}

// 每行一个短语；忽略空行，不按空格或逗号拆分，避免破坏短语内部结构。
export function parsePhraseInput(text: string): PhraseInputItem[] {
  if (text.length > 4000) throw new PhraseError('INVALID_INPUT')
  const lines = text.split(/\r\n|\r|\n/u)
  const seen = new Map<string, number>()
  const items: PhraseInputItem[] = []
  for (const line of lines) {
    const input = line.trim()
    if (!input) continue
    const phrase = normalizePhrase(input)
    if (!phrase || phrase.length > PHRASE_MAX_LENGTH) throw new PhraseError('INVALID_INPUT')
    const inputIndex = items.length
    const sourceInputIndex = seen.get(phrase)
    if (sourceInputIndex === undefined) seen.set(phrase, inputIndex)
    items.push({
      inputIndex,
      input,
      phrase,
      ...(sourceInputIndex === undefined ? {} : { sourceInputIndex })
    })
    if (items.length > 20) throw new PhraseError('INVALID_INPUT')
  }
  if (!items.length) throw new PhraseError('INVALID_INPUT')
  return items
}
