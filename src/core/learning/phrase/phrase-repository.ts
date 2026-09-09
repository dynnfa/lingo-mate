import type { ListPhraseInput, PhraseBatch, PhraseEntry, PhrasePage } from '../../../shared/phrase'
import type { PhraseInsertContent } from '../../tools/phrase-tools'

export type PhraseSaveStatus = 'saved' | 'existing'

export interface PhraseRepository {
  // 批次预查：一次读取已收录短语，键为规范化 phrase 文本。
  findExisting(phrases: string[]): Map<string, PhraseEntry>
  // 在同一短事务内插入合法内容并保存最终批次报告。
  saveBatchWithResult(
    executionId: string,
    contents: PhraseInsertContent[],
    finalize: (saved: PhraseSaveStatus[]) => PhraseBatch
  ): PhraseBatch
  // 按 phrase COLLATE BINARY 升序分页读取；cursor 为上一页最后一条短语原文。
  list(input: ListPhraseInput): PhrasePage
  // 按短语主键精确删除一条：目标存在并删除返回 true，不存在返回 false（幂等）。
  // 只删除 phrase 表中的记录，不改写历史会话消息与收录批次报告。
  deleteByPhrase(phrase: string): boolean
}
