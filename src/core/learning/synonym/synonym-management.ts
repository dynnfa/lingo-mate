import {
  synonymListInputSchema,
  type SynonymGroupPage,
  type SynonymListInput
} from '../../../shared/synonym'
import type { SynonymRepository } from './synonym-repository'

// 已记录页的近义词管理入口：校验领域输入后委托仓储执行。
// 只负责分组列表读取，不触碰模型分析流程，
// 也不改写历史会话消息与收藏批次报告。
export class SynonymManagementService {
  constructor(private readonly repository: SynonymRepository) {}

  list(raw: SynonymListInput): SynonymGroupPage {
    const input = synonymListInputSchema.parse(raw)
    return this.repository.listGroups(input)
  }
}
