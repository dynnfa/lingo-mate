import { useCallback, useEffect, useRef, useState } from 'react'
import type { ImportTask, TransferErrorCode } from '../../../../shared/vocabulary-transfer'

export function useVocabularyImport(onSaved: () => void): {
  task: ImportTask | null
  error: TransferErrorCode | null
  setError: (error: TransferErrorCode | null) => void
  accept: (task: ImportTask | null) => void
  active: boolean
} {
  const [task, setTask] = useState<ImportTask | null>(null)
  const [error, setError] = useState<TransferErrorCode | null>(null)
  const current = useRef<ImportTask | null>(null)
  const saved = useRef(new Set<string>())
  const onSavedRef = useRef(onSaved)
  const refreshRef = useRef<() => Promise<void>>(async () => {})
  useEffect(() => {
    onSavedRef.current = onSaved
  }, [onSaved])
  const accept = useCallback((next: ImportTask | null) => {
    if (!next) return
    if (current.current?.requestId === next.requestId && current.current.revision > next.revision)
      return
    current.current = next
    setTask(next)
    if (next.counts.saved && !saved.current.has(next.requestId)) {
      saved.current.add(next.requestId)
      onSavedRef.current()
    }
  }, [])
  useEffect(() => {
    let disposed = false
    let fetching = false
    const unsubscribe = window.api.vocabulary.onImportProgress((next) => {
      if (!disposed) accept(next)
    })
    const refresh = async (): Promise<void> => {
      if (fetching) return
      fetching = true
      const before = current.current
      try {
        const result = await window.api.vocabulary.getImportTask({})
        if (!disposed && current.current === before && result.status === 'ok') accept(result.task)
        if (!disposed && result.status === 'error') setError(result.error.code)
      } catch {
        if (!disposed) setError('UNKNOWN_ERROR')
      } finally {
        fetching = false
      }
    }
    refreshRef.current = refresh
    // 挂载时查询一次以恢复切换菜单前的任务；此后进度主要靠事件推送。
    void refresh()
    return () => {
      disposed = true
      unsubscribe()
    }
  }, [accept])
  const active = task?.phase === 'analyzing' || task?.phase === 'committing'
  useEffect(() => {
    // 查询是权威兜底：仅在任务进行期间轮询，丢失的终态事件不会让 UI 永久等待。
    if (!active) return
    const timer = setInterval(() => {
      void refreshRef.current()
    }, 1000)
    return () => clearInterval(timer)
  }, [active])
  return {
    task,
    error,
    setError,
    accept,
    active
  }
}
