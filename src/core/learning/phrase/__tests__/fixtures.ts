import type { PhraseEntry } from '../../../../shared/phrase'
import type { PhraseInsertContent } from '../phrase-tools'
import type { PhraseAnalysisResult } from '../phrase-analyzer'
import type { PhraseRepository, PhraseSaveStatus } from '../phrase-repository'
import { normalizePhrase } from '../parse-phrase-input'

export function content(
  phrase = 'look forward to',
  overrides: Partial<PhraseInsertContent> = {}
): PhraseInsertContent {
  return {
    phrase,
    explantation: '期待，盼望（某件将发生的事）。',
    example: 'I look forward to hearing from you.',
    ...overrides
  }
}

export const insertResult = (phrase = 'look forward to'): PhraseAnalysisResult => ({
  status: 'insert',
  content: content(phrase),
  modelId: 'fixture-model',
  promptVersion: 'phrase-tools-v1'
})

function toEntry(stored: PhraseInsertContent): PhraseEntry {
  return { phrase: stored.phrase, explantation: stored.explantation, example: stored.example }
}

// 内存仓储：以规范化 phrase 为唯一键，模拟事务内的复查与冲突语义。
// list/delete 与 SQLite 实现一致：默认字符串比较即 BINARY 规则，游标为上一页末条原文。
export function memoryRepository(): PhraseRepository & { contents: PhraseInsertContent[] } {
  const contents: PhraseInsertContent[] = []
  const save = (values: PhraseInsertContent[]): PhraseSaveStatus[] =>
    values.map((value) => {
      const key = normalizePhrase(value.phrase)
      const existing = contents.find((item) => normalizePhrase(item.phrase) === key)
      if (existing) return 'existing' as const
      contents.push(value)
      return 'saved' as const
    })
  return {
    contents,
    findExisting: (phrases) => {
      const found = new Map<string, PhraseEntry>()
      for (const phrase of phrases) {
        const entry = contents.find((item) => normalizePhrase(item.phrase) === phrase)
        if (entry) found.set(phrase, toEntry(entry))
      }
      return found
    },
    saveBatchWithResult: (_executionId, values, finalize) => finalize(save(values)),
    list: ({ limit, cursor }) => {
      const pageSize = limit ?? 50
      const sorted = [...contents].sort((a, b) => (a.phrase < b.phrase ? -1 : 1))
      const after = cursor ? sorted.filter((item) => item.phrase > cursor) : sorted
      const page = after.slice(0, pageSize)
      const hasMore = after.length > pageSize && page.length > 0
      return {
        entries: page.map(toEntry),
        ...(hasMore ? { nextCursor: page[page.length - 1].phrase } : {})
      }
    },
    deleteByPhrase: (phrase) => {
      const index = contents.findIndex((item) => item.phrase === phrase)
      if (index === -1) return false
      contents.splice(index, 1)
      return true
    }
  }
}
