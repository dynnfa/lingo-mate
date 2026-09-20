import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  VocabularyMistakeHistoryCursor,
  VocabularyMistakeHistoryItem,
  VocabularyMistakeListItem,
  VocabularyMistakesListCursor
} from '../../../../shared/vocabulary-mistakes'
import { useCursorList } from '../../hooks/useCursorList'

// 单个展开词条的错误历史分页状态；phase 仅覆盖首屏读取。
export interface MistakeHistoryState {
  phase: 'loading' | 'ready' | 'error'
  items: VocabularyMistakeHistoryItem[]
  nextCursor: VocabularyMistakeHistoryCursor | null
  loadingMore: boolean
  moreError: unknown | null
}

// 错题集状态 hook：聚合列表复用 useCursorList；展开词条各自持有独立的
// 历史分页状态机（首屏加载 / 追加 / 失败重试），收起即丢弃，重新展开
// 重新读取最新历史。进入页面时列表整体重新加载。
// historiesRef 与 React 状态同刻写入（同 useCursorList 的 ref 镜像模式），
// 事件回调读取不经渲染闭包，也不依赖提交后才执行的被动 effect。
export function useVocabularyMistakes(): {
  list: ReturnType<typeof useCursorList<VocabularyMistakeListItem, VocabularyMistakesListCursor>>
  histories: Record<string, MistakeHistoryState>
  toggleHistory: (entryId: string) => void
  retryHistory: (entryId: string) => void
  loadMoreHistory: (entryId: string) => void
} {
  const list = useCursorList<VocabularyMistakeListItem, VocabularyMistakesListCursor>({
    keyOf: (entry) => entry.entryId,
    load: async (cursor) => {
      const result = await window.api.vocabularyMistakes.list(cursor === null ? {} : { cursor })
      if (result.status === 'error') throw result.error.code
      return { entries: result.entries, nextCursor: result.nextCursor ?? null }
    }
  })

  const [histories, setHistories] = useState<Record<string, MistakeHistoryState>>({})
  const mountedRef = useRef(true)
  const expandedRef = useRef(new Set<string>())
  const historiesRef = useRef<Record<string, MistakeHistoryState>>({})
  const historySeqRef = useRef(new Map<string, number>())

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  // 唯一写入路径：ref 镜像与 React 状态持有同一份新对象。
  const writeHistories = useCallback(
    (
      update: (current: Record<string, MistakeHistoryState>) => Record<string, MistakeHistoryState>
    ): void => {
      const next = update(historiesRef.current)
      historiesRef.current = next
      setHistories(next)
    },
    []
  )

  const applyHistory = useCallback(
    (entryId: string, update: (state: MistakeHistoryState) => MistakeHistoryState): void => {
      writeHistories((current) => {
        const state = current[entryId]
        if (!state) return current
        return { ...current, [entryId]: update(state) }
      })
    },
    [writeHistories]
  )

  // 读取一页历史：seq 守卫丢弃收起或过期的响应；kind 区分首屏失败
  // （进 error 态）与追加失败（保留已展示条目）。
  const requestHistory = useCallback(
    (entryId: string, cursor: VocabularyMistakeHistoryCursor | null, kind: 'initial' | 'more') => {
      const seq = (historySeqRef.current.get(entryId) ?? 0) + 1
      historySeqRef.current.set(entryId, seq)
      const fail = (code?: unknown): void => {
        if (!mountedRef.current || historySeqRef.current.get(entryId) !== seq) return
        applyHistory(entryId, (state) =>
          kind === 'initial'
            ? { ...state, phase: 'error' }
            : { ...state, loadingMore: false, moreError: code ?? 'UNKNOWN_ERROR' }
        )
      }
      window.api.vocabularyMistakes
        .listHistory(cursor === null ? { entryId } : { entryId, cursor })
        .then(
          (result) => {
            if (result.status === 'error') {
              fail(result.error.code)
              return
            }
            if (!mountedRef.current || historySeqRef.current.get(entryId) !== seq) return
            applyHistory(entryId, (state) => ({
              phase: 'ready',
              items: [
                ...state.items,
                ...result.items.filter((item) => !state.items.some((shown) => shown.id === item.id))
              ],
              nextCursor: result.nextCursor ?? null,
              loadingMore: false,
              moreError: null
            }))
          },
          () => fail()
        )
    },
    [applyHistory]
  )

  const toggleHistory = useCallback(
    (entryId: string): void => {
      if (expandedRef.current.has(entryId)) {
        expandedRef.current.delete(entryId)
        // 使收起前的在途响应永久过期；保留递增序号，避免重新展开时复用身份。
        historySeqRef.current.set(entryId, (historySeqRef.current.get(entryId) ?? 0) + 1)
        writeHistories((current) => {
          const next = { ...current }
          delete next[entryId]
          return next
        })
        return
      }
      expandedRef.current.add(entryId)
      writeHistories((current) => ({
        ...current,
        [entryId]: {
          phase: 'loading',
          items: [],
          nextCursor: null,
          loadingMore: false,
          moreError: null
        }
      }))
      requestHistory(entryId, null, 'initial')
    },
    [requestHistory, writeHistories]
  )

  const retryHistory = useCallback(
    (entryId: string): void => {
      if (!expandedRef.current.has(entryId)) return
      applyHistory(entryId, (state) => ({
        ...state,
        phase: 'loading',
        loadingMore: false,
        moreError: null
      }))
      requestHistory(entryId, null, 'initial')
    },
    [applyHistory, requestHistory]
  )

  const loadMoreHistory = useCallback(
    (entryId: string): void => {
      const state = historiesRef.current[entryId]
      if (!state || state.nextCursor === null || state.loadingMore) return
      applyHistory(entryId, (current) => ({ ...current, loadingMore: true, moreError: null }))
      requestHistory(entryId, state.nextCursor, 'more')
    },
    [applyHistory, requestHistory]
  )

  return { list, histories, toggleHistory, retryHistory, loadMoreHistory }
}
