import { randomUUID } from 'node:crypto'
import type { SupportedLocale } from '../../../shared/preferences'
import {
  VOCABULARY_PRACTICE_COUNT_MAX,
  VOCABULARY_PRACTICE_COUNT_MIN,
  VOCABULARY_PRACTICE_MEANING_MAX_LENGTH
} from '../../../shared/vocabulary-practice'
import type { VocabularyEntry } from '../../../shared/vocabulary'
import { abortableOperation } from './abortable-operation'
import { VocabularyPracticeError } from './parse-vocabulary-practice-input'
import type {
  PracticeReviewEntry,
  PracticeReviewOutcome,
  VocabularyPracticeReviewer
} from './vocabulary-practice-reviewer'

// 抽词依赖的窄接口：只要求能按数量随机取样，测试可注入内存实现。
export interface VocabularyPracticeSource {
  sampleRandom(count: number): VocabularyEntry[]
}

export interface VocabularyPracticeAnswerInput {
  entryId: string
  meaning: string
}

interface PracticeSession {
  id: string
  // 轮次开始时的词条快照：审查期间词库变化不混入新内容。
  entries: Map<string, VocabularyEntry>
  review: { controller: AbortController } | undefined
}

export interface VocabularyPracticeStartOutcome {
  sessionId: string
  requestedCount: number
  entries: Array<{ entryId: string; term: string }>
}

const REVIEW_TOTAL_TIMEOUT_MS = 120_000

// 词汇练习领域服务：内存保存单例会话，负责数量约束、抽词快照与审查生命周期。
// 练习与审查状态不落库；新一轮 start 会中止旧轮次未完成的审查。
export class VocabularyPracticeService {
  private active: PracticeSession | undefined

  constructor(
    private readonly source: VocabularyPracticeSource,
    private readonly createReviewer: () => VocabularyPracticeReviewer,
    private readonly totalReviewTimeoutMs = REVIEW_TOTAL_TIMEOUT_MS
  ) {}

  start(count: number): VocabularyPracticeStartOutcome {
    if (!Number.isInteger(count) || count < VOCABULARY_PRACTICE_COUNT_MIN) {
      throw new VocabularyPracticeError('INVALID_INPUT')
    }
    if (count > VOCABULARY_PRACTICE_COUNT_MAX) {
      throw new VocabularyPracticeError('INVALID_INPUT')
    }
    this.cancelActiveReview()
    const sampled = this.source.sampleRandom(count)
    const entries = new Map<string, VocabularyEntry>()
    for (const entry of sampled) {
      // 随机取样按主键天然不重复；防御重复 ID 只保留首个。
      if (!entries.has(entry.id)) entries.set(entry.id, entry)
    }
    this.active = { id: randomUUID(), entries, review: undefined }
    return {
      sessionId: this.active.id,
      requestedCount: count,
      entries: [...entries.values()].map((entry) => ({ entryId: entry.id, term: entry.term }))
    }
  }

  async review(
    sessionId: string,
    answers: VocabularyPracticeAnswerInput[],
    explanationLanguage: SupportedLocale
  ): Promise<PracticeReviewOutcome> {
    const session = this.requireSession(sessionId)
    if (session.review) throw new VocabularyPracticeError('BUSY')
    const reviewEntries = this.resolveReviewEntries(session, answers)
    const controller = new AbortController()
    session.review = { controller }
    try {
      return await abortableOperation(controller.signal, this.totalReviewTimeoutMs, (signal) =>
        this.createReviewer().review({
          entries: reviewEntries,
          explanationLanguage,
          signal
        })
      )
    } finally {
      session.review = undefined
    }
  }

  // 取消当前审查：返回是否存在被中止的在途审查；答案与会话保留。
  cancel(sessionId: string): boolean {
    const session = this.active
    if (!session || session.id !== sessionId || !session.review) return false
    session.review.controller.abort(new VocabularyPracticeError('CANCELLED'))
    return true
  }

  dispose(): void {
    this.cancelActiveReview()
    this.active = undefined
  }

  private requireSession(sessionId: string): PracticeSession {
    const session = this.active
    if (!session || session.id !== sessionId) throw new VocabularyPracticeError('SESSION_NOT_FOUND')
    return session
  }

  // 答案必须与本轮快照一一对应：拒绝漏项、重复或非本轮 ID，
  // 由 Core 组装可信单词，Renderer 无法替换被审查内容。
  private resolveReviewEntries(
    session: PracticeSession,
    answers: VocabularyPracticeAnswerInput[]
  ): PracticeReviewEntry[] {
    if (answers.length !== session.entries.size) throw new VocabularyPracticeError('INVALID_INPUT')
    const seen = new Set<string>()
    const entries: PracticeReviewEntry[] = []
    for (const answer of answers) {
      const entry = session.entries.get(answer.entryId)
      const meaning = typeof answer.meaning === 'string' ? answer.meaning.trim() : ''
      if (
        !entry ||
        seen.has(answer.entryId) ||
        meaning.length < 1 ||
        meaning.length > VOCABULARY_PRACTICE_MEANING_MAX_LENGTH
      ) {
        throw new VocabularyPracticeError('INVALID_INPUT')
      }
      seen.add(answer.entryId)
      entries.push({
        entryId: entry.id,
        term: entry.term,
        submittedMeaning: meaning,
        referenceMeaning: entry.meaning
      })
    }
    return entries
  }

  private cancelActiveReview(): void {
    const review = this.active?.review
    if (review) review.controller.abort(new VocabularyPracticeError('CANCELLED'))
  }
}
