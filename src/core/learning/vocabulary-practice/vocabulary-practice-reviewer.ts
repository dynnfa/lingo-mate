import type { SupportedLocale } from '../../../shared/preferences'

// 发送给模型的单条审查条目：单词与参考释义由 Core 从快照组装，
// 参考释义可为 null（历史未回填），不作为唯一合法答案。
export interface PracticeReviewEntry {
  entryId: string
  term: string
  submittedMeaning: string
  referenceMeaning: string | null
}

export interface PracticeReviewOutcome {
  verdict: 'all_correct' | 'has_errors'
  summary: string
  marks: Array<{ entryId: string; field: 'meaning'; reason: string }>
}

// 词汇练习审查器：内部完成多轮工具调用循环（标红 + 最终 JSON 反馈），
// 只在结果与累计标记一致时返回；取消、超时与协议错误抛领域错误。
export interface VocabularyPracticeReviewer {
  review(input: {
    entries: PracticeReviewEntry[]
    explanationLanguage: SupportedLocale
    signal: AbortSignal
  }): Promise<PracticeReviewOutcome>
}
