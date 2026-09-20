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
  VocabularyMistakeRecord,
  VocabularyMistakeRepository
} from './vocabulary-mistake-repository'
import type {
  PracticeReviewEntry,
  PracticeReviewOutcome,
  VocabularyPracticeReviewer
} from './vocabulary-practice-reviewer'

// 抽词依赖的窄接口：只要求能按数量随机取样，测试可注入内存实现。
export interface VocabularyPracticeSource {
  sampleRandom(count: number): VocabularyEntry[]
}

// 错题写入依赖的窄接口：完整仓储接口的结构子集，测试可注入内存实现。
export type VocabularyPracticeMistakeSink = Pick<VocabularyMistakeRepository, 'saveBatch'>

export interface VocabularyPracticeAnswerInput {
  entryId: string
  meaning: string
}

// 最近一次已完成的审查：保存失败后的重试复用其结果，不再调用模型。
interface CompletedReview {
  requestId: string
  answers: PracticeReviewEntry[]
  outcome: PracticeReviewOutcome
}

interface PracticeSession {
  id: string
  // 轮次开始时的词条快照：审查期间词库变化不混入新内容。
  entries: Map<string, VocabularyEntry>
  review: { controller: AbortController } | undefined
  completedReview: CompletedReview | undefined
}

export interface VocabularyPracticeStartOutcome {
  sessionId: string
  requestedCount: number
  entries: Array<{ entryId: string; term: string }>
}

const REVIEW_TOTAL_TIMEOUT_MS = 120_000

// 词汇练习领域服务：内存保存单例会话，负责数量约束、抽词快照、审查
// 生命周期与错题收集。练习与审查会话状态不落库；审查成功后按校验过的
// 错误标记把错题整批写入仓储，新一轮 start 会中止旧轮次未完成的审查。
export class VocabularyPracticeService {
  private active: PracticeSession | undefined

  constructor(
    private readonly source: VocabularyPracticeSource,
    private readonly createReviewer: () => VocabularyPracticeReviewer,
    private readonly mistakes: VocabularyPracticeMistakeSink,
    private readonly totalReviewTimeoutMs = REVIEW_TOTAL_TIMEOUT_MS,
    private readonly now: () => Date = () => new Date()
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
    this.active = { id: randomUUID(), entries, review: undefined, completedReview: undefined }
    return {
      sessionId: this.active.id,
      requestedCount: count,
      entries: [...entries.values()].map((entry) => ({ entryId: entry.id, term: entry.term }))
    }
  }

  // requestId 是一次提交审查的稳定标识：同 ID 重试复用已完成的审查结果
  // （含保存重试，不重新调用模型），同 ID 携带不同答案被拒绝。
  async review(
    sessionId: string,
    requestId: string,
    answers: VocabularyPracticeAnswerInput[],
    explanationLanguage: SupportedLocale
  ): Promise<PracticeReviewOutcome> {
    const session = this.requireSession(sessionId)
    if (session.review) throw new VocabularyPracticeError('BUSY')
    const reviewEntries = this.resolveReviewEntries(session, answers)

    const completed = session.completedReview
    if (completed && completed.requestId === requestId) {
      if (!sameSubmission(completed.answers, reviewEntries)) {
        throw new VocabularyPracticeError('INVALID_INPUT')
      }
      // 保存重试：仓储按 (review_id, entry_id) 幂等，重复写入不重复计数。
      this.saveMistakes(requestId, completed.outcome, reviewEntries)
      return completed.outcome
    }

    const controller = new AbortController()
    session.review = { controller }
    try {
      const outcome = await abortableOperation(
        controller.signal,
        this.totalReviewTimeoutMs,
        (signal) =>
          this.createReviewer().review({
            entries: reviewEntries,
            explanationLanguage,
            signal
          })
      )
      this.validateMarks(session, outcome)
      // 先缓存已完成审查再写入：保存失败时重试可复用结果，不再次调用模型。
      session.completedReview = { requestId, answers: reviewEntries, outcome }
      this.saveMistakes(requestId, outcome, reviewEntries)
      return outcome
    } finally {
      session.review = undefined
    }
  }

  // 取消当前审查：返回是否存在被中止的在途审查；答案与会话保留。
  // 审查完成后的错题写入是同步短事务，取消无法撤销已保存结果。
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

  // 错误标记必须与本轮快照一致：不认识的外部词条、重复标记以及与
  // 判定矛盾的结果都按无效审查处理，不静默遗漏错题。
  private validateMarks(session: PracticeSession, outcome: PracticeReviewOutcome): void {
    if ((outcome.verdict === 'all_correct') !== (outcome.marks.length === 0)) {
      throw new VocabularyPracticeError('INVALID_ANALYSIS')
    }
    const seen = new Set<string>()
    for (const mark of outcome.marks) {
      if (!session.entries.has(mark.entryId) || seen.has(mark.entryId)) {
        throw new VocabularyPracticeError('INVALID_ANALYSIS')
      }
      seen.add(mark.entryId)
    }
  }

  private saveMistakes(
    requestId: string,
    outcome: PracticeReviewOutcome,
    answers: PracticeReviewEntry[]
  ): void {
    const mistakes = collectMistakeRecords(requestId, outcome, answers, this.now())
    if (!mistakes.length) return
    try {
      this.mistakes.saveBatch(mistakes)
    } catch (cause) {
      throw new VocabularyPracticeError('STORAGE_FAILED', { cause })
    }
  }

  private cancelActiveReview(): void {
    const review = this.active?.review
    if (review) review.controller.abort(new VocabularyPracticeError('CANCELLED'))
  }
}

function sameSubmission(cached: PracticeReviewEntry[], current: PracticeReviewEntry[]): boolean {
  if (cached.length !== current.length) return false
  const meanings = new Map(cached.map((entry) => [entry.entryId, entry.submittedMeaning]))
  return current.every((entry) => meanings.get(entry.entryId) === entry.submittedMeaning)
}

// 每个错误项保存单词快照、本次提交释义与发生时间；正确项不收集。
function collectMistakeRecords(
  requestId: string,
  outcome: PracticeReviewOutcome,
  answers: PracticeReviewEntry[],
  at: Date
): VocabularyMistakeRecord[] {
  if (outcome.verdict === 'all_correct') return []
  const submitted = new Map(answers.map((entry) => [entry.entryId, entry]))
  const createdAt = at.toISOString()
  return outcome.marks.map((mark) => {
    const entry = submitted.get(mark.entryId)
    if (!entry) throw new VocabularyPracticeError('INVALID_ANALYSIS')
    return {
      id: randomUUID(),
      reviewId: requestId,
      entryId: mark.entryId,
      term: entry.term,
      submittedMeaning: entry.submittedMeaning,
      createdAt
    }
  })
}
