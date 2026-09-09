import {
  deletePhraseInputSchema,
  listPhraseInputSchema,
  type DeletePhraseInput,
  type ListPhraseInput,
  type PhrasePage
} from '../../../shared/phrase'
import type { PhraseRepository } from './phrase-repository'

export interface PhraseDeleteOutcome {
  phrase: string
  deleted: boolean
}

// 已记录页的短语管理入口：校验领域输入后委托仓储执行。
// 只负责读取与单条删除，不触碰模型分析流程，
// 也不改写历史会话消息与收藏批次报告。
export class PhraseManagementService {
  constructor(private readonly repository: PhraseRepository) {}

  list(raw: ListPhraseInput): PhrasePage {
    const input = listPhraseInputSchema.parse(raw)
    return this.repository.list(input)
  }

  deleteByPhrase(raw: DeletePhraseInput): PhraseDeleteOutcome {
    const { phrase } = deletePhraseInputSchema.parse(raw)
    return { phrase, deleted: this.repository.deleteByPhrase(phrase) }
  }
}
