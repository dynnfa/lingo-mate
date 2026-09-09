import {
  deleteVocabularyInputSchema,
  listVocabularyInputSchema,
  type DeleteVocabularyInput,
  type ListVocabularyInput,
  type VocabularyPage
} from '../../../shared/vocabulary'
import type { VocabularyRepository } from './vocabulary-repository'

export interface VocabularyDeleteOutcome {
  id: string
  deleted: boolean
}

// 已记录页的词汇管理入口：校验领域输入后委托仓储执行。
// 只负责读取与单条删除，不触碰模型分析流程，
// 也不改写历史会话消息与收藏批次报告。
export class VocabularyManagementService {
  constructor(private readonly repository: VocabularyRepository) {}

  list(raw: ListVocabularyInput): VocabularyPage {
    const input = listVocabularyInputSchema.parse(raw)
    return this.repository.list(input)
  }

  deleteById(raw: DeleteVocabularyInput): VocabularyDeleteOutcome {
    const { id } = deleteVocabularyInputSchema.parse(raw)
    return { id, deleted: this.repository.deleteById(id) }
  }
}
