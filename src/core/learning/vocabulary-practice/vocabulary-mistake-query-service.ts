import {
  listVocabularyMistakeHistoryInputSchema,
  listVocabularyMistakesInputSchema,
  type ListVocabularyMistakeHistoryInput,
  type ListVocabularyMistakesInput
} from '../../../shared/vocabulary-mistakes'
import type {
  VocabularyMistakeHistoryPage,
  VocabularyMistakeRepository,
  VocabularyMistakesPage
} from './vocabulary-mistake-repository'

// 错题集页面的只读查询入口：校验领域输入后委托仓储执行聚合列表与
// 单词条历史分页；不提供写入、删除或读取其他用户数据的入口。
export class VocabularyMistakeQueryService {
  constructor(private readonly repository: VocabularyMistakeRepository) {}

  list(raw: ListVocabularyMistakesInput): VocabularyMistakesPage {
    const input = listVocabularyMistakesInputSchema.parse(raw)
    return this.repository.list(input)
  }

  listHistory(raw: ListVocabularyMistakeHistoryInput): VocabularyMistakeHistoryPage {
    const input = listVocabularyMistakeHistoryInputSchema.parse(raw)
    return this.repository.listHistory(input)
  }
}
