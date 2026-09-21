import type { SupportedLocale } from '../../../shared/preferences'

// 模型生成器接口：一次请求返回一批候选（不做领域校验）；候选的结构/去重/
// 词形与例句包含等规则由 ExploreVocabularyModule 统一裁决，生成器只负责
// 通信协议。

export interface ExploreVocabularyGenerateInput {
  // 本次请求需要的候选数量：初次为 10，补足时为剩余数量。
  count: number
  wordLanguage: 'en'
  explanationLanguage: SupportedLocale
  // 禁用列表：历史单词与本次已接受候选的规范化键，作为数据处理传入。
  excludedTerms: string[]
  signal: AbortSignal
}

export interface ExploreVocabularyCandidate {
  term: string
  explanation: string
  example: string
}

export interface ExploreVocabularyGenerator {
  generate(input: ExploreVocabularyGenerateInput): Promise<ExploreVocabularyCandidate[]>
}
