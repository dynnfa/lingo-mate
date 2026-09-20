import type { SupportedLocale } from '../../../shared/preferences'

// 模型生成器接口：一次请求返回一批候选（不做领域校验）；候选的 结构/去重/
// 例句包含等规则由 ExplorePhraseModule 统一裁决，生成器只负责通信协议。
export interface ExplorePhraseGenerateInput {
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
