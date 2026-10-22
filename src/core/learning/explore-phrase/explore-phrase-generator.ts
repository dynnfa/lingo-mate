import type { SupportedLocale } from '../../../shared/preferences'

// 模型生成器接口：一次请求返回一批候选（不做领域校验）；候选的 结构/去重/
// 例句包含等规则由 ExplorePhraseHostSession 统一裁决，生成器只负责通信协议。
export interface ExplorePhraseGenerateInput {
  // Python 提供的完整指令，宿主不再选择或拼接 Agent Prompt。
  systemPrompt: string
  // 本次请求需要的候选数量：初次为 10，补足时为剩余数量。
  count: number
  wordLanguage: 'en'
  explanationLanguage: SupportedLocale
  // 禁用列表：历史短语与本次已接受候选的规范化键，作为数据处理传入。
  excludedPhrases: string[]
  signal: AbortSignal
}

export interface ExplorePhraseCandidate {
  phrase: string
  explanation: string
  example: string
}

export interface ExplorePhraseGenerator {
  generate(input: ExplorePhraseGenerateInput): Promise<ExplorePhraseCandidate[]>
}

export function explorePhraseUserContent(
  input: Pick<
    ExplorePhraseGenerateInput,
    'count' | 'wordLanguage' | 'explanationLanguage' | 'excludedPhrases'
  >
): string {
  return JSON.stringify({
    count: input.count,
    wordLanguage: input.wordLanguage,
    explanationLanguage: input.explanationLanguage,
    excludedPhrases: input.excludedPhrases
  })
}
