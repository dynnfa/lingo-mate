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
        if (!disposed && result.status === 'ok' && current.current === before) accept(result.task)
        if (!disposed && result.status === 'error') setError(result.error.code)
      } catch {
        if (!disposed) setError('UNKNOWN_ERROR')
      } finally {
        fetching = false
      }
    }
    void refresh()
    // Query is authoritative; a lost final event cannot leave the UI generating forever.
    const timer = setInterval(() => {
      void refresh()
    }, 1000)
    return () => {
      disposed = true
      clearInterval(timer)
      unsubscribe()
    }
  }, [accept])
  return {
    task,
    error,
    setError,
    accept,
    active: task?.phase === 'analyzing' || task?.phase === 'committing'
  }
}
