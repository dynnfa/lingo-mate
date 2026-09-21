import { basename, dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { open, readFile, readdir, rename, rm } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import {
  EXPLORE_PHRASE_HISTORY_BATCH_LIMIT,
  explorePhraseHistoryBatchSchema,
  explorePhraseHistoryDocumentSchema,
  type ExplorePhraseBatch,
  type ExplorePhraseHistoryDocument
} from '../shared/explore-phrase'
import { ExplorePhraseError } from '../core/learning/explore-phrase/explore-phrase-error'
import type {
  CommitExplorePhraseBatchInput,
  CommitExplorePhraseBatchOptions,
  ExplorePhraseHistoryStore
} from '../core/learning/explore-phrase/explore-phrase-history-store'
import { normalizeExplorePhrase } from '../core/learning/explore-phrase/normalize-explore-phrase'

// /explore-phrase 的 JSON 文件历史存储：<userData>/explore-phrase-history.json。
// Main 是唯一应用内写入方；完整 JSON 先写入同目录唯一临时文件，flush 后通过
// 原子 rename 替换目标文件，添加新批次与淘汰旧批次在同一次替换中生效。

function parseHistoryDocument(raw: string): ExplorePhraseHistoryDocument {
  // 空文件不得当作空历史：不覆盖原文档，返回可理解的错误。
  if (raw.trim() === '') throw new ExplorePhraseError('HISTORY_UNREADABLE')
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (cause) {
    throw new ExplorePhraseError('HISTORY_UNREADABLE', { cause })
  }
  const result = explorePhraseHistoryDocumentSchema.safeParse(parsed)
  if (!result.success) {
    throw new ExplorePhraseError('HISTORY_UNREADABLE', { cause: result.error })
  }
  assertHistoryInvariants(result.data)
  return result.data
}

// 跨批次不变量：执行/消息身份唯一、跨批次短语去重、normalizedPhrase 与
// 应用重新计算的值一致。
function assertHistoryInvariants(document: ExplorePhraseHistoryDocument): void {
  const executionIds = new Set<string>()
  const userMessageIds = new Set<string>()
  const phrases = new Set<string>()
  for (const batch of document.batches) {
    if (executionIds.has(batch.executionId) || userMessageIds.has(batch.userMessageId)) {
      throw new ExplorePhraseError('HISTORY_UNREADABLE')
    }
    executionIds.add(batch.executionId)
    userMessageIds.add(batch.userMessageId)
    for (const item of batch.items) {
      if (normalizeExplorePhrase(item.phrase) !== item.normalizedPhrase) {
        throw new ExplorePhraseError('HISTORY_UNREADABLE')
      }
      if (phrases.has(item.normalizedPhrase)) {
        throw new ExplorePhraseError('HISTORY_UNREADABLE')
      }
      phrases.add(item.normalizedPhrase)
    }
  }
}

function documentsEqual(
  left: ExplorePhraseHistoryDocument,
  right: ExplorePhraseHistoryDocument
): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

async function syncDirectory(directory: string): Promise<void> {
  let handle: FileHandle | undefined
  try {
    handle = await open(directory, 'r')
    await handle.sync()
  } finally {
    await handle?.close()
  }
}

export class JsonFileExplorePhraseHistoryStore implements ExplorePhraseHistoryStore {
  constructor(private readonly filePath: string) {}

  async read(): Promise<ExplorePhraseHistoryDocument> {
    let raw: string
    try {
      raw = await readFile(this.filePath, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        // 文件不存在视为首次使用。
        return { schemaVersion: 1, batches: [] }
      }
      throw new ExplorePhraseError('HISTORY_UNREADABLE', { cause: error })
    }
    return parseHistoryDocument(raw)
  }

  async findBatchByUserMessage(userMessageId: string): Promise<ExplorePhraseBatch | undefined> {
    const document = await this.read()
    return document.batches.find((batch) => batch.userMessageId === userMessageId)
  }

  async commit(
    input: CommitExplorePhraseBatchInput,
    options: CommitExplorePhraseBatchOptions
  ): Promise<ExplorePhraseBatch> {
    const current = await this.read()
    // 生成期间外部编辑：终止本次提交，保留外部内容。
    if (!documentsEqual(current, options.base)) {
      throw new ExplorePhraseError('HISTORY_MODIFIED')
    }
    // 幂等：同 executionId 或稳定 userMessageId 已提交时直接返回完整结果。
    const existing = current.batches.find(
      (batch) =>
        batch.executionId === input.executionId || batch.userMessageId === input.userMessageId
    )
    if (existing) return existing

    const newBatch = buildBatch(input)
    const knownPhrases = new Set(
      current.batches.flatMap((batch) => batch.items.map((item) => item.normalizedPhrase))
    )
    for (const item of newBatch.items) {
      if (knownPhrases.has(item.normalizedPhrase)) {
        throw new ExplorePhraseError('STORAGE_FAILED')
      }
    }

    const batches = [...current.batches, newBatch]
    // 以数组提交顺序淘汰最旧批次；尚未补齐回复的受保护批次不可淘汰，
    // 需要淘汰它时本次提交整体失败并保留原文件。
    while (batches.length > EXPLORE_PHRASE_HISTORY_BATCH_LIMIT) {
      const oldest = batches[0]
      if (options.isProtected && (await options.isProtected(oldest))) {
        throw new ExplorePhraseError('RECOVERY_PENDING')
      }
      batches.shift()
    }
    await this.writeAtomically({ schemaVersion: 1, batches }, newBatch.executionId, options.signal)
    return newBatch
  }

  // 启动时清理遗留临时文件：临时文件只是写入过程产物，不当作已提交历史。
  async cleanupLeftoverTempFiles(): Promise<void> {
    const directory = dirname(this.filePath)
    let entries: string[]
    try {
      entries = await readdir(directory)
    } catch {
      return
    }
    const prefix = `${basename(this.filePath)}.tmp-`
    await Promise.all(
      entries
        .filter((name) => name.startsWith(prefix))
        .map((name) => rm(join(directory, name), { force: true }).catch(() => undefined))
    )
  }

  private async writeAtomically(
    document: ExplorePhraseHistoryDocument,
    executionId: string,
    signal?: AbortSignal
  ): Promise<void> {
    const tempPath = `${this.filePath}.tmp-${randomUUID()}`
    let handle: FileHandle | undefined
    try {
      handle = await open(tempPath, 'w')
      await handle.writeFile(JSON.stringify(document, null, 2), 'utf8')
      await handle.sync()
      await handle.close()
      handle = undefined
      if (signal?.aborted) throw new ExplorePhraseError('CANCELLED')
      await rename(tempPath, this.filePath)
    } catch (cause) {
      if (handle) await handle.close().catch(() => undefined)
      // 写入或替换失败：保留旧文件，清理临时文件。
      await rm(tempPath, { force: true }).catch(() => undefined)
      if (cause instanceof ExplorePhraseError && cause.code === 'CANCELLED') throw cause
      throw new ExplorePhraseError('STORAGE_FAILED', { cause })
    }
    // 替换后的目录同步失败属于提交状态不确定：重读目标文件按 executionId
    // 核实，不盲目重写、也不声称已回滚。
    try {
      await syncDirectory(dirname(this.filePath))
    } catch (cause) {
      try {
        const verified = await this.read()
        if (verified.batches.some((batch) => batch.executionId === executionId)) return
      } catch (verificationError) {
        throw new ExplorePhraseError('COMMIT_UNCERTAIN', { cause: verificationError })
      }
      throw new ExplorePhraseError('COMMIT_UNCERTAIN', { cause })
    }
  }
}

function buildBatch(input: CommitExplorePhraseBatchInput): ExplorePhraseBatch {
  const result = explorePhraseHistoryBatchSchema.safeParse(input)
  if (!result.success) {
    throw new ExplorePhraseError('STORAGE_FAILED', { cause: result.error })
  }
  // 新批次的规范化键必须与应用重新计算的值一致。
  for (const item of result.data.items) {
    if (normalizeExplorePhrase(item.phrase) !== item.normalizedPhrase) {
      throw new ExplorePhraseError('STORAGE_FAILED')
    }
  }
  return result.data
}
