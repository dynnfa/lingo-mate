import type {
  SynonymBatch,
  SynonymEntry,
  SynonymGroup,
  SynonymGroupPage,
  SynonymListInput
} from '../../../shared/synonym'

// 分组与分页结构复用 Shared 协议：模型工具扫描与界面列表读取共用形状。
export type { SynonymGroup, SynonymGroupPage }
export type SynonymWrite = {
  word: string
  meaning: string
  distinction: string
} & ({ groupid: string } | { groupMeaning: string })
export interface SynonymSaveResult {
  status: 'saved' | 'existing'
  entry: SynonymEntry
}
export interface SynonymRepository {
  findExisting(words: string[]): Map<string, SynonymEntry>
  // 模型工具扫描：受组数分页与响应预算（词数/字符数）约束。
  findGroups(cursor?: string): SynonymGroupPage
  // 界面列表读取：每页固定组数、组内返回全部成员，不受扫描预算约束。
  listGroups(raw: SynonymListInput): SynonymGroupPage
  saveWord(
    executionId: string,
    content: SynonymWrite,
    finalize: (result: SynonymSaveResult) => SynonymBatch
  ): SynonymSaveResult
  saveReport(executionId: string, report: SynonymBatch): void
}
