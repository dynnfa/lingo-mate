import type {
  ListVocabularyMistakeHistoryQuery,
  ListVocabularyMistakesQuery
} from '../../../shared/vocabulary-mistakes'
import type {
  VocabularyMistakeHistoryPage,
  VocabularyMistakeRepository,
  VocabularyMistakesPage
} from './vocabulary-mistake-repository'

// 错题集页面的只读查询入口：输入已在 IPC 进程边界完成 schema 校验
// （含 limit 默认值补全），这里直接委托仓储执行聚合列表与单词条历史
// 分页；不提供写入、删除或读取其他用户数据的入口。
export class VocabularyMistakeQueryService {
  constructor(private readonly repository: VocabularyMistakeRepository) {}

  list(query: ListVocabularyMistakesQuery): VocabularyMistakesPage {
    return this.repository.list(query)
  }

  listHistory(query: ListVocabularyMistakeHistoryQuery): VocabularyMistakeHistoryPage {
    return this.repository.listHistory(query)
  }
}
