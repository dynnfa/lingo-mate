import { useCallback, useState } from 'react'
import type {
  VocabularyMistakeListItem,
  VocabularyMistakesListCursor
} from '../../../../shared/vocabulary-mistakes'
import { useCursorList } from '../../hooks/useCursorList'

// 错题集状态 hook：聚合列表复用 useCursorList；展开的词条集合驱动
// VocabularyMistakeHistory 子组件的挂载与卸载——挂载即读取首屏历史，
// 收起即丢弃分页状态，重新展开重新读取。进入页面时列表整体重新加载。
export function useVocabularyMistakes(): {
  list: ReturnType<typeof useCursorList<VocabularyMistakeListItem, VocabularyMistakesListCursor>>
  expandedEntryIds: ReadonlySet<string>
  toggleHistory: (entryId: string) => void
} {
  const list = useCursorList<VocabularyMistakeListItem, VocabularyMistakesListCursor>({
    keyOf: (entry) => entry.entryId,
    load: async (cursor) => {
      const result = await window.api.vocabularyMistakes.list(cursor === null ? {} : { cursor })
      if (result.status === 'error') throw result.error.code
      return { entries: result.entries, nextCursor: result.nextCursor ?? null }
    }
  })

  const [expandedEntryIds, setExpandedEntryIds] = useState<ReadonlySet<string>>(() => new Set())

  const toggleHistory = useCallback((entryId: string): void => {
    setExpandedEntryIds((current) => {
      const next = new Set(current)
      if (next.has(entryId)) {
        next.delete(entryId)
      } else {
        next.add(entryId)
      }
      return next
    })
  }, [])

  return { list, expandedEntryIds, toggleHistory }
}
