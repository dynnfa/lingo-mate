import type { SupportedLocale } from '../../../shared/preferences'
import type {
  ExploreVocabularyBatch,
  ExploreVocabularyHistoryDocument,
  ExploreVocabularyHistoryItem
} from '../../../shared/explore-vocabulary'

// JSON 历史文件存储接口：Core 依赖该抽象，不直接调用文件系统；
// 由 Main 注入具体实现（固定路径 <userData>/explore-vocabulary-history.json）。

export interface CommitExploreVocabularyBatchInput {
  executionId: string
  sessionId: string
  userMessageId: string
  committedAt: string
  wordLanguage: 'en'
  explanationLanguage: SupportedLocale
  items: ExploreVocabularyHistoryItem[]
}

export interface CommitExploreVocabularyBatchOptions {
  // Cancellation is checked immediately before atomic replacement, never after it.
  signal?: AbortSignal
  // 生成开始时读取的文档快照：提交前核对文件未被外部编辑。
  base: ExploreVocabularyHistoryDocument
  // 返回 true 的历史批次不可被 7 批窗口淘汰（尚未补齐回复的批次）。
  isProtected?: (batch: ExploreVocabularyBatch) => boolean | Promise<boolean>
}

export interface ExploreVocabularyHistoryStore {
  // 读取并完整校验文档；文件不存在视为首次使用（空历史）。
  // 空文件、损坏、未知版本或权限错误按 HISTORY_UNREADABLE 失败，不当作空历史。
  read(): Promise<ExploreVocabularyHistoryDocument>
  findBatchByUserMessage(userMessageId: string): Promise<ExploreVocabularyBatch | undefined>
  // 幂等提交：按 executionId/userMessageId 查重命中时直接返回已提交批次；
  // 否则追加新批次、按提交顺序淘汰最旧批次并原子替换文件。
  commit(
    input: CommitExploreVocabularyBatchInput,
    options: CommitExploreVocabularyBatchOptions
  ): Promise<ExploreVocabularyBatch>
}
