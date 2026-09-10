import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  VocabularyPracticeEntry,
  VocabularyPracticeErrorCode
} from '../../../shared/vocabulary-practice'

// 加载 → 练习（active）→ 审查中（reviewing）→ 完成（done）；
// 空词库进入 empty，失败回到 active（答案保留）。
export type VocabularyPracticePhase = 'idle' | 'loading' | 'empty' | 'active' | 'reviewing' | 'done'

export interface VocabularyPracticeState {
  phase: VocabularyPracticePhase
  sessionId: string | undefined
  entries: VocabularyPracticeEntry[]
  answers: Record<string, string>
  requestedCount: number | undefined
  marks: Record<string, string>
  verdict: 'all_correct' | 'has_errors' | undefined
  summary: string | undefined
  error: { code: VocabularyPracticeErrorCode; scope: 'start' | 'review' } | undefined
  notice: 'cancelled' | undefined
}

const INITIAL_STATE: VocabularyPracticeState = {
  phase: 'idle',
  sessionId: undefined,
  entries: [],
  answers: {},
  requestedCount: undefined,
  marks: {},
  verdict: undefined,
  summary: undefined,
  error: undefined,
  notice: undefined
}

// 词汇练习状态 hook：集中管理与 IPC 的交互、旧轮次迟到结果忽略与
// 卸载时取消在途审查；审查期间答案被冻结（组件按 phase 禁用编辑）。
export function useVocabularyPractice(): {
  state: VocabularyPracticeState
  hasAnyAnswer: boolean
  start: (count: number) => void
  setAnswer: (entryId: string, value: string) => void
  submit: () => void
  cancelReview: () => void
  dismissError: () => void
} {
  const [state, setState] = useState<VocabularyPracticeState>(INITIAL_STATE)
  const mountedRef = useRef(true)
  const sessionRef = useRef<string | undefined>(undefined)
  const startSeqRef = useRef(0)
  const reviewSeqRef = useRef(0)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      // 退出详情时中止在途审查；迟到结果由 seq/mounted 守卫忽略。
      const sessionId = sessionRef.current
      if (sessionId) void window.api.vocabularyPractice.cancel({ sessionId }).catch(() => {})
    }
  }, [])

  const start = useCallback((count: number): void => {
    // 新一轮开启前中止旧轮次在途审查，旧结果按序号忽略。
    const previousSession = sessionRef.current
    if (previousSession)
      void window.api.vocabularyPractice.cancel({ sessionId: previousSession }).catch(() => {})
    reviewSeqRef.current += 1
    const seq = ++startSeqRef.current
    setState({ ...INITIAL_STATE, phase: 'loading' })
    window.api.vocabularyPractice
      .start({ requestId: crypto.randomUUID(), count })
      .then((result) => {
        if (!mountedRef.current || startSeqRef.current !== seq) return
        if (result.status === 'error') {
          setState({ ...INITIAL_STATE, error: { code: result.error.code, scope: 'start' } })
          return
        }
        sessionRef.current = result.sessionId
        const answers: Record<string, string> = {}
        for (const entry of result.entries) answers[entry.entryId] = ''
        setState({
          ...INITIAL_STATE,
          phase: result.entries.length === 0 ? 'empty' : 'active',
          sessionId: result.sessionId,
          entries: result.entries,
          answers,
          requestedCount: result.requestedCount
        })
      })
      .catch(() => {
        if (!mountedRef.current || startSeqRef.current !== seq) return
        setState({ ...INITIAL_STATE, error: { code: 'UNKNOWN_ERROR', scope: 'start' } })
      })
  }, [])

  const setAnswer = useCallback((entryId: string, value: string): void => {
    setState((current) => {
      if (current.phase !== 'active' && current.phase !== 'done') return current
      // 修改答案即放弃上一轮审查结果，需重新提交。
      const reviewed = current.phase === 'done'
      return {
        ...current,
        phase: 'active',
        answers: { ...current.answers, [entryId]: value },
        ...(reviewed ? { marks: {}, verdict: undefined, summary: undefined } : {})
      }
    })
  }, [])

  const submit = useCallback((): void => {
    const sessionId = sessionRef.current
    if (!sessionId || state.phase !== 'active') return
    const answers = state.entries.map((entry) => ({
      entryId: entry.entryId,
      meaning: state.answers[entry.entryId] ?? ''
    }))
    const seq = ++reviewSeqRef.current
    setState((current) => ({ ...current, phase: 'reviewing', error: undefined, notice: undefined }))
    window.api.vocabularyPractice
      .review({ requestId: crypto.randomUUID(), sessionId, answers })
      .then((result) => {
        if (!mountedRef.current || reviewSeqRef.current !== seq) return
        if (result.status === 'error') {
          if (result.error.code === 'CANCELLED') {
            setState((current) => ({ ...current, phase: 'active', notice: 'cancelled' }))
            return
          }
          setState((current) => ({
            ...current,
            phase: 'active',
            error: { code: result.error.code, scope: 'review' }
          }))
          return
        }
        const marks: Record<string, string> = {}
        for (const mark of result.marks) marks[mark.entryId] = mark.reason
        setState((current) => ({
          ...current,
          phase: 'done',
          marks,
          verdict: result.verdict,
          summary: result.summary
        }))
      })
      .catch(() => {
        if (!mountedRef.current || reviewSeqRef.current !== seq) return
        setState((current) => ({
          ...current,
          phase: 'active',
          error: { code: 'UNKNOWN_ERROR', scope: 'review' }
        }))
      })
  }, [state.entries, state.answers, state.phase])

  const cancelReview = useCallback((): void => {
    const sessionId = sessionRef.current
    if (!sessionId) return
    window.api.vocabularyPractice
      .cancel({ sessionId })
      .then((result) => {
        if (!mountedRef.current || result.status === 'error') return
        if (!result.cancelled) return
        setState((current) =>
          current.phase === 'reviewing' ? { ...current, phase: 'active' } : current
        )
      })
      .catch(() => {})
  }, [])

  const dismissError = useCallback((): void => {
    setState((current) => ({ ...current, error: undefined }))
  }, [])

  const hasAnyAnswer = Object.values(state.answers).some((value) => value.trim().length > 0)

  return { state, hasAnyAnswer, start, setAnswer, submit, cancelReview, dismissError }
}
