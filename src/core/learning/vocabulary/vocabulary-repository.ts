import type {
  VocabularyEntry,
  ListVocabularyInput,
  VocabularyBatch,
  VocabularyPage
} from '../../../shared/vocabulary'
import type { VocabularyInsertCommand } from './vocabulary-insert'

export interface VocabularyRepository {
  find(lookupKey: string): VocabularyEntry | undefined
  // 批次预查：一次读取词项建立 key 索引，避免逐词扫描词库。
  findExisting(lookupKeys: string[]): Map<string, VocabularyEntry>
  // Synchronous short transaction. No cancellation or async work may interleave with commit.
  saveBatch(
    commands: VocabularyInsertCommand[]
  ): Array<{ id: string; status: 'saved' | 'existing' }>
  // Executes the validated model-returned INSERT commands and saves the execution
  // report in one short transaction.
  saveBatchWithResult(
    executionId: string,
    commands: VocabularyInsertCommand[],
    finalize: (saved: Array<{ id: string; status: 'saved' | 'existing' }>) => VocabularyBatch
  ): VocabularyBatch
  list(input: ListVocabularyInput): VocabularyPage
  // 按记录 id 精确删除一条词汇：目标存在并删除返回 true，不存在返回 false（幂等）。
  // 不改写历史会话消息与收藏批次报告。
  deleteById(id: string): boolean
}
