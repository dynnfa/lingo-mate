import type { PhraseBatch, PhraseEntry } from '../../../shared/phrase'
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
}
