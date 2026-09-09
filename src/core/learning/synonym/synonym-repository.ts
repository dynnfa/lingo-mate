import type { SynonymBatch, SynonymEntry } from '../../../shared/synonym'

export interface SynonymGroup {
  id: string
  meaning: string
  words: SynonymEntry[]
}
export interface SynonymGroupPage {
  groups: SynonymGroup[]
  nextCursor: string | null
}
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
  findGroups(cursor?: string): SynonymGroupPage
  saveWord(
    executionId: string,
    content: SynonymWrite,
    finalize: (result: SynonymSaveResult) => SynonymBatch
  ): SynonymSaveResult
  saveReport(executionId: string, report: SynonymBatch): void
}
