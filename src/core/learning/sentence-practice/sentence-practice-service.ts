import { randomUUID } from 'node:crypto'
import type { SupportedLocale, TargetLanguage } from '../../../shared/preferences'
import {
  SENTENCE_PRACTICE_ANSWER_MAX_LENGTH,
  SENTENCE_PRACTICE_HINT_COUNT_MAX,
  SENTENCE_PRACTICE_HINT_COUNT_MIN,
  SENTENCE_PRACTICE_WORD_COUNT,
  sentencePracticeHintSchema,
  sentencePracticeReviewSchema,
  type SentencePracticeReview
} from '../../../shared/sentence-practice'
import type { VocabularyEntry } from '../../../shared/vocabulary'
import { abortableOperation } from './abortable-operation'
import { SentencePracticeError } from './parse-sentence-practice-input'
import type {
  SentenceHint,
  SentenceHintEntry,
  SentenceHintGenerator,
  SentencePracticeReviewer
} from './sentence-practice-models'

// 抽词依赖的窄接口：只要求能按数量随机取样，测试可注入内存实现。
export interface SentencePracticeSource {
  sampleRandom(count: number): VocabularyEntry[]
}

interface SentenceOperation {
  kind: 'hints' | 'review'
  requestId: string
  controller: AbortController
}

interface SentenceSession {
  id: string
  // 轮次开始时的词条快照：提示与点评期间词库变化不混入新内容。
  entries: Map<string, VocabularyEntry>
  // 最近一次成功生成的提示快照；点评请求按此组装，重生成时整体替换。
  hints: SentenceHint[] | undefined
  operation: SentenceOperation | undefined
}

export interface SentencePracticeStartOutcome {
  sessionId: string
  entries: Array<{ entryId: string; term: string }>
}

const HINTS_TOTAL_TIMEOUT_MS = 120_000
const REVIEW_TOTAL_TIMEOUT_MS = 120_000

const hintsSchema = sentencePracticeHintSchema
  .array()
  .min(SENTENCE_PRACTICE_HINT_COUNT_MIN)
  .max(SENTENCE_PRACTICE_HINT_COUNT_MAX)

// 造句练习服务：独立于词汇练习的内存会话，负责固定三词抽样、提示
// 生成、答案点评、超时与取消；不写词库，也不持久化练习历史。
export class SentencePracticeService {
  private active: SentenceSession | undefined

  constructor(
    private readonly source: SentencePracticeSource,
    private readonly createHintGenerator: () => SentenceHintGenerator,
    private readonly createReviewer: () => SentencePracticeReviewer,
    private readonly totalHintsTimeoutMs = HINTS_TOTAL_TIMEOUT_MS,
    private readonly totalReviewTimeoutMs = REVIEW_TOTAL_TIMEOUT_MS
  ) {}

  start(): SentencePracticeStartOutcome {
    this.cancelActiveOperation()
    const sampled = this.source.sampleRandom(SENTENCE_PRACTICE_WORD_COUNT)
    // 仓储返回超出请求数量的词条属于协议违规，按无效输入拒绝。
    if (sampled.length > SENTENCE_PRACTICE_WORD_COUNT) {
      throw new SentencePracticeError('INVALID_INPUT')
    }
    const entries = new Map<string, VocabularyEntry>()
    for (const entry of sampled) {
      // 防御仓储返回重复 ID：同 ID 只保留首个，跨轮允许重复词条。
      if (!entries.has(entry.id)) entries.set(entry.id, entry)
    }
    this.active = { id: randomUUID(), entries, hints: undefined, operation: undefined }
    return {
      sessionId: this.active.id,
      entries: [...entries.values()].map((entry) => ({ entryId: entry.id, term: entry.term }))
    }
  }

  async generateHints(
    sessionId: string,
    requestId: string,
    explanationLanguage: SupportedLocale,
    practiceLanguage: TargetLanguage
  ): Promise<SentenceHint[]> {
    const session = this.requireSession(sessionId)
    if (session.operation) throw new SentencePracticeError('BUSY')
    // 词库不足 3 个的轮次不发起模型调用。
    if (session.entries.size !== SENTENCE_PRACTICE_WORD_COUNT) {
      throw new SentencePracticeError('INVALID_INPUT')
    }
    const hintEntries: SentenceHintEntry[] = [...session.entries.values()].map((entry) => ({
      entryId: entry.id,
      term: entry.term,
      referenceMeaning: entry.meaning
    }))
    const hints = await this.runOperation(
      session,
      'hints',
      requestId,
      this.totalHintsTimeoutMs,
      (signal) =>
        this.createHintGenerator().generate({
          entries: hintEntries,
          explanationLanguage,
          practiceLanguage,
          signal
        })
    )
    const validated = this.validateHints(hints, session)
    session.hints = validated
    return validated
  }

  async review(
    sessionId: string,
    requestId: string,
    answer: string,
    explanationLanguage: SupportedLocale,
    practiceLanguage: TargetLanguage
  ): Promise<SentencePracticeReview> {
    const session = this.requireSession(sessionId)
    if (session.operation) throw new SentencePracticeError('BUSY')
    // 点评依赖本轮提示快照；提示未就绪（含生成失败）时不可提交。
    if (!session.hints || session.entries.size !== SENTENCE_PRACTICE_WORD_COUNT) {
      throw new SentencePracticeError('INVALID_INPUT')
    }
    const trimmed = typeof answer === 'string' ? answer.trim() : ''
    if (trimmed.length < 1 || trimmed.length > SENTENCE_PRACTICE_ANSWER_MAX_LENGTH) {
      throw new SentencePracticeError('INVALID_INPUT')
    }
    const entries = [...session.entries.values()].map((entry) => ({
      entryId: entry.id,
      term: entry.term
    }))
    const hints = session.hints
    const review = await this.runOperation(
      session,
      'review',
      requestId,
      this.totalReviewTimeoutMs,
      (signal) =>
        this.createReviewer().review({
          entries,
          hints,
          answer: trimmed,
          explanationLanguage,
          practiceLanguage,
          signal
        })
    )
    return this.validateReview(review, session)
  }

  // 按会话与请求 ID 中止在途调用；会话、单词、提示与答案保留可重试。
  cancel(sessionId: string, requestId: string): boolean {
    const operation = this.active?.operation
    if (!this.active || this.active.id !== sessionId) return false
    if (!operation || operation.requestId !== requestId) return false
    operation.controller.abort(new SentencePracticeError('CANCELLED'))
    return true
  }

  // 中止在途调用并释放会话；重复关闭幂等。
  close(sessionId: string): boolean {
    const session = this.active
    if (!session || session.id !== sessionId) return false
    this.cancelActiveOperation()
    this.active = undefined
    return true
  }

  dispose(): void {
    this.cancelActiveOperation()
    this.active = undefined
  }

  private requireSession(sessionId: string): SentenceSession {
    const session = this.active
    if (!session || session.id !== sessionId) throw new SentencePracticeError('SESSION_NOT_FOUND')
    return session
  }

  private async runOperation<T>(
    session: SentenceSession,
    kind: 'hints' | 'review',
    requestId: string,
    timeoutMs: number,
    operation: (signal: AbortSignal) => Promise<T>
  ): Promise<T> {
    const controller = new AbortController()
    session.operation = { kind, requestId, controller }
    try {
      return await abortableOperation(controller.signal, timeoutMs, operation)
    } finally {
      session.operation = undefined
    }
  }

  // 模型输出按 schema 与本轮快照双重校验：提示须 3–6 条、引用 ID
  // 属于本轮且合计覆盖全部词条，越界即按无效分析处理。
  private validateHints(hints: SentenceHint[], session: SentenceSession): SentenceHint[] {
    const parsed = hintsSchema.safeParse(hints)
    if (!parsed.success)
      throw new SentencePracticeError('INVALID_ANALYSIS', { cause: parsed.error })
    const covered = new Set<string>()
    for (const hint of parsed.data) {
      for (const entryId of hint.entryIds) {
        if (!session.entries.has(entryId)) throw new SentencePracticeError('INVALID_ANALYSIS')
        covered.add(entryId)
      }
    }
    if (covered.size !== session.entries.size) throw new SentencePracticeError('INVALID_ANALYSIS')
    return parsed.data
  }

  // 点评须与本轮词条一一对应；结构或 ID 矛盾都按无效分析处理。
  private validateReview(
    review: SentencePracticeReview,
    session: SentenceSession
  ): SentencePracticeReview {
    const parsed = sentencePracticeReviewSchema.safeParse(review)
    if (!parsed.success)
      throw new SentencePracticeError('INVALID_ANALYSIS', { cause: parsed.error })
    const usageIds = new Set(parsed.data.wordUsage.map((usage) => usage.entryId))
    if (
      usageIds.size !== session.entries.size ||
      [...usageIds].some((id) => !session.entries.has(id))
    )
      throw new SentencePracticeError('INVALID_ANALYSIS')
    return parsed.data
  }

  private cancelActiveOperation(): void {
    const operation = this.active?.operation
    if (operation) operation.controller.abort(new SentencePracticeError('CANCELLED'))
  }
}
