import type { SupportedLocale, TargetLanguage } from '../../../shared/preferences'
import type { SentencePracticeReview } from '../../../shared/sentence-practice'

// 发送给提示生成的单词条目：参考释义由 Core 从快照组装，可为 null
// （历史未回填）；模型缺失参考时按通常词义生成，不回填词库。
export interface SentenceHintEntry {
  entryId: string
  term: string
  referenceMeaning: string | null
}

export interface SentenceHint {
  entryIds: string[]
  phrase: string
  explanation: string
}

// 造句提示生成器：为满 3 词的轮次生成 3–6 条 phrase/搭配提示，
// 合计覆盖全部词条；取消、超时与协议错误抛领域错误。
export interface SentenceHintGenerator {
  generate(input: {
    entries: SentenceHintEntry[]
    explanationLanguage: SupportedLocale
    practiceLanguage: TargetLanguage
    signal: AbortSignal
  }): Promise<SentenceHint[]>
}

// 造句点评器：按单词、通顺度与语法三个维度审查用户答案，
// 返回结构化点评；取消、超时与协议错误抛领域错误。
export interface SentencePracticeReviewer {
  review(input: {
    entries: Array<{ entryId: string; term: string }>
    hints: SentenceHint[]
    answer: string
    explanationLanguage: SupportedLocale
    practiceLanguage: TargetLanguage
    signal: AbortSignal
  }): Promise<SentencePracticeReview>
}

// Transport-only models require the complete Python-owned system instruction.
export interface SentencePracticeHintModel {
  generate(
    input: Parameters<SentenceHintGenerator['generate']>[0] & { systemPrompt: string }
  ): Promise<SentenceHint[]>
}
export interface SentencePracticeReviewModel {
  review(
    input: Parameters<SentencePracticeReviewer['review']>[0] & { systemPrompt: string }
  ): Promise<SentencePracticeReview>
}
