import type { SupportedLocale } from '../../../shared/preferences'
import type {
  ExplorePhraseBatch,
  ExplorePhraseHistoryDocument,
  ExplorePhraseHistoryItem
} from '../../../shared/explore-phrase'

// JSON 历史文件存储接口：Core 依赖该抽象，不直接调用文件系统；
// 由 Main 注入具体实现（固定路径 <userData>/explore-phrase-history.json）。

export interface CommitExplorePhraseBatchInput {
  executionId: string
  sessionId: string
  userMessageId: string
  committedAt: string
  wordLanguage: 'en'
  explanationLanguage: SupportedLocale
  items: ExplorePhraseHistoryItem[]
}

export interface CommitExplorePhraseBatchOptions {
  // 生成开始时读取的文档快照：提交前核对文件未被外部编辑。
  base: ExplorePhraseHistoryDocument
  // 返回 true 的历史批次不可被 7 批窗口淘汰（尚未补齐回复的批次）。
  isProtected?: (batch: ExplorePhraseBatch) => boolean | Promise<boolean>
}

export interface ExplorePhraseHistoryStore {
  // 读取并完整校验文档；文件不存在视为首次使用（空历史）。
  // 空文件、损坏、未知版本或权限错误按 HISTORY_UNREADABLE 失败，不当作空历史。
  read(): Promise<ExplorePhraseHistoryDocument>
  findBatchByUserMessage(userMessageId: string): Promise<ExplorePhraseBatch | undefined>
  // 幂等提交：按 executionId/userMessageId 查重命中时直接返回已提交批次；
  // 否则追加新批次、按提交顺序淘汰最旧批次并原子替换文件。
  commit(
    input: CommitExplorePhraseBatchInput,
    options: CommitExplorePhraseBatchOptions
  ): Promise<ExplorePhraseBatch>
}
