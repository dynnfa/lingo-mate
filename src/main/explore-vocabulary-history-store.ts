import {
  EXPLORE_VOCABULARY_HISTORY_BATCH_LIMIT,
  exploreVocabularyHistoryBatchSchema,
  exploreVocabularyHistoryDocumentSchema,
  type ExploreVocabularyBatch,
  type ExploreVocabularyHistoryDocument
} from '../shared/explore-vocabulary'
import { ExploreVocabularyError } from '../core/learning/explore-vocabulary/explore-vocabulary-error'
import type {
  CommitExploreVocabularyBatchInput,
  CommitExploreVocabularyBatchOptions,
  ExploreVocabularyHistoryStore
} from '../core/learning/explore-vocabulary/explore-vocabulary-history-store'
import { normalizeExploreVocabularyTerm } from '../core/learning/explore-vocabulary/normalize-explore-vocabulary'
import {
  cleanupJsonHistoryTempFiles,
  readJsonHistoryFile,
  writeJsonHistoryFileAtomically
} from './json-history-file'

// /explore-vocabulary 的 JSON 文件历史存储：<userData>/explore-vocabulary-history.json。
// Main 是唯一应用内写入方；完整 JSON 先写入同目录唯一临时文件，flush 后通过
// 原子 rename 替换目标文件，添加新批次与淘汰旧批次在同一次替换中生效。
// 物理读写机制与 explore-phrase 共享（json-history-file.ts），本文件只持有
// 词汇 schema、规范化规则与提交语义；两个技能的历史文件、去重窗口与锁
// 分别独立。

function parseHistoryDocument(raw: string): ExploreVocabularyHistoryDocument {
  // 空文件不得当作空历史：不覆盖原文档，返回可理解的错误。
  if (raw.trim() === '') throw new ExploreVocabularyError('HISTORY_UNREADABLE')
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (cause) {
    throw new ExploreVocabularyError('HISTORY_UNREADABLE', { cause })
  }
  const result = exploreVocabularyHistoryDocumentSchema.safeParse(parsed)
  if (!result.success) {
    throw new ExploreVocabularyError('HISTORY_UNREADABLE', { cause: result.error })
  }
  assertHistoryInvariants(result.data)
  return result.data
}

// 跨批次不变量：执行/消息身份唯一、跨批次单词去重、normalizedTerm 与
// 应用重新计算的值一致。
function assertHistoryInvariants(document: ExploreVocabularyHistoryDocument): void {
  const executionIds = new Set<string>()
  const userMessageIds = new Set<string>()
  const terms = new Set<string>()
  for (const batch of document.batches) {
    if (executionIds.has(batch.executionId) || userMessageIds.has(batch.userMessageId)) {
      throw new ExploreVocabularyError('HISTORY_UNREADABLE')
    }
    executionIds.add(batch.executionId)
    userMessageIds.add(batch.userMessageId)
    for (const item of batch.items) {
      if (normalizeExploreVocabularyTerm(item.term) !== item.normalizedTerm) {
        throw new ExploreVocabularyError('HISTORY_UNREADABLE')
      }
      if (terms.has(item.normalizedTerm)) {
        throw new ExploreVocabularyError('HISTORY_UNREADABLE')
      }
      terms.add(item.normalizedTerm)
    }
  }
}

function documentsEqual(
  left: ExploreVocabularyHistoryDocument,
  right: ExploreVocabularyHistoryDocument
): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

function toUnreadable(cause?: unknown): ExploreVocabularyError {
  return cause === undefined
    ? new ExploreVocabularyError('HISTORY_UNREADABLE')
    : new ExploreVocabularyError('HISTORY_UNREADABLE', { cause })
}

export class JsonFileExploreVocabularyHistoryStore implements ExploreVocabularyHistoryStore {
  constructor(private readonly filePath: string) {}

  async read(): Promise<ExploreVocabularyHistoryDocument> {
    return readJsonHistoryFile(
      this.filePath,
      () => ({ schemaVersion: 1, batches: [] }),
      parseHistoryDocument,
      toUnreadable
    )
  }

  async findBatchByUserMessage(userMessageId: string): Promise<ExploreVocabularyBatch | undefined> {
    const document = await this.read()
    return document.batches.find((batch) => batch.userMessageId === userMessageId)
  }

  async commit(
    input: CommitExploreVocabularyBatchInput,
    options: CommitExploreVocabularyBatchOptions
  ): Promise<ExploreVocabularyBatch> {
    const current = await this.read()
    // 生成期间外部编辑：终止本次提交，保留外部内容。
    if (!documentsEqual(current, options.base)) {
      throw new ExploreVocabularyError('HISTORY_MODIFIED')
    }
    // 幂等：同 executionId 或稳定 userMessageId 已提交时直接返回完整结果。
    const existing = current.batches.find(
      (batch) =>
        batch.executionId === input.executionId || batch.userMessageId === input.userMessageId
    )
    if (existing) return existing

    const newBatch = buildBatch(input)
    const knownTerms = new Set(
      current.batches.flatMap((batch) => batch.items.map((item) => item.normalizedTerm))
    )
    for (const item of newBatch.items) {
      if (knownTerms.has(item.normalizedTerm)) {
        throw new ExploreVocabularyError('STORAGE_FAILED')
      }
    }

    const batches = [...current.batches, newBatch]
    // 以数组提交顺序淘汰最旧批次；尚未补齐回复的受保护批次不可淘汰，
    // 需要淘汰它时本次提交整体失败并保留原文件。
    while (batches.length > EXPLORE_VOCABULARY_HISTORY_BATCH_LIMIT) {
      const oldest = batches[0]
      if (options.isProtected && (await options.isProtected(oldest))) {
        throw new ExploreVocabularyError('RECOVERY_PENDING')
      }
      batches.shift()
    }
    await this.writeAtomically({ schemaVersion: 1, batches }, newBatch.executionId, options.signal)
    return newBatch
  }

  // 启动时清理遗留临时文件：临时文件只是写入过程产物，不当作已提交历史。
  async cleanupLeftoverTempFiles(): Promise<void> {
    await cleanupJsonHistoryTempFiles(this.filePath)
  }

  private async writeAtomically(
    document: ExploreVocabularyHistoryDocument,
    executionId: string,
    signal?: AbortSignal
  ): Promise<void> {
    await writeJsonHistoryFileAtomically({
      filePath: this.filePath,
      document,
      signal,
      mechanics: {
        unreadable: toUnreadable,
        cancelled: () => new ExploreVocabularyError('CANCELLED'),
        storageFailed: (cause) =>
          cause === undefined
            ? new ExploreVocabularyError('STORAGE_FAILED')
            : new ExploreVocabularyError('STORAGE_FAILED', { cause }),
        commitUncertain: (cause) =>
          cause === undefined
            ? new ExploreVocabularyError('COMMIT_UNCERTAIN')
            : new ExploreVocabularyError('COMMIT_UNCERTAIN', { cause })
      },
      verifyCommitted: async () =>
        (await this.read()).batches.some((batch) => batch.executionId === executionId)
    })
  }
}

function buildBatch(input: CommitExploreVocabularyBatchInput): ExploreVocabularyBatch {
  const result = exploreVocabularyHistoryBatchSchema.safeParse(input)
  if (!result.success) {
    throw new ExploreVocabularyError('STORAGE_FAILED', { cause: result.error })
  }
  // 新批次的规范化键必须与应用重新计算的值一致。
  for (const item of result.data.items) {
    if (normalizeExploreVocabularyTerm(item.term) !== item.normalizedTerm) {
      throw new ExploreVocabularyError('STORAGE_FAILED')
    }
  }
  return result.data
}
