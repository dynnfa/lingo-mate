import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  SentencePracticeEntry,
  SentencePracticeErrorCode,
  SentencePracticeHint,
  SentencePracticeReview
} from '../../../../shared/sentence-practice'

// 抽词（loading）→ 提示生成（hinting）→ 可作答（ready）→ 点评中
// （reviewing）→ 完成（done）；词库不足 3 个进入 empty，提示失败进入
// hintFailed（可对同一组单词重试），点评失败或取消回到 ready（答案保留）。
export type SentencePracticePhase =
  'idle' | 'loading' | 'empty' | 'hinting' | 'hintFailed' | 'ready' | 'reviewing' | 'done'

export interface SentencePracticeState {
  phase: SentencePracticePhase
  sessionId: string | undefined
  entries: SentencePracticeEntry[]
  hints: SentencePracticeHint[] | undefined
  answer: string
  review: SentencePracticeReview | undefined
  error: { code: SentencePracticeErrorCode; scope: 'start' | 'hints' | 'review' } | undefined
  notice: 'cancelled' | undefined
}

const INITIAL_STATE: SentencePracticeState = {
  phase: 'idle',
  sessionId: undefined,
  entries: [],
  hints: undefined,
  answer: '',
  review: undefined,
  error: undefined,
  notice: undefined
}

// 造句练习状态 hook：集中管理与 IPC 的交互、旧轮次与迟到结果忽略、
// 卸载时中止在途请求并释放会话；点评期间答案被冻结（组件按 phase 禁用）。
export function useSentencePractice(): {
  state: SentencePracticeState
  startRound: () => void
  regenerateHints: () => void
  setAnswer: (value: string) => void
  submit: () => void
  cancelActive: () => void
} {
  const [state, setState] = useState<SentencePracticeState>(INITIAL_STATE)
  const mountedRef = useRef(true)
  const sessionRef = useRef<string | undefined>(undefined)
  // 当前在途模型调用的请求 ID：取消与释放按会话 + 请求 ID 精确中止。
  const activeRequestIdRef = useRef<string | undefined>(undefined)
  const startSeqRef = useRef(0)
  const hintsSeqRef = useRef(0)
  const reviewSeqRef = useRef(0)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      startSeqRef.current += 1
      hintsSeqRef.current += 1
      reviewSeqRef.current += 1
      // 切换菜单或退出页面时中止在途请求并释放会话；close 幂等。
      const sessionId = sessionRef.current
      if (sessionId) {
        void window.api.sentencePractice.close({ sessionId }).catch(() => {})
        sessionRef.current = undefined
      }
    }
  }, [])

  const releasePreviousSession = useCallback((): void => {
    const sessionId = sessionRef.current
    if (!sessionId) return
    sessionRef.current = undefined
    activeRequestIdRef.current = undefined
    // close 在 Main 侧中止在途调用并释放会话，迟到结果由 seq/mounted 守卫忽略。
    void window.api.sentencePractice.close({ sessionId }).catch(() => {})
  }, [])

  const requestHints = useCallback((sessionId: string): void => {
    const requestId = crypto.randomUUID()
    activeRequestIdRef.current = requestId
    const seq = ++hintsSeqRef.current
    setState((current) => ({
      ...current,
      phase: 'hinting',
      hints: undefined,
      error: undefined,
      notice: undefined
    }))
    window.api.sentencePractice
      .hints({ requestId, sessionId })
      .then((result) => {
        if (!mountedRef.current || hintsSeqRef.current !== seq || sessionRef.current !== sessionId)
          return
        if (result.status === 'error') {
          // 取消保留单词与答案（如有），提示未就绪进入可重试状态。
          if (result.error.code === 'CANCELLED') {
            setState((current) => ({ ...current, phase: 'hintFailed', notice: 'cancelled' }))
            return
          }
          setState((current) => ({
            ...current,
            phase: 'hintFailed',
            error: { code: result.error.code, scope: 'hints' }
          }))
          return
        }
        setState((current) => ({ ...current, phase: 'ready', hints: result.hints }))
      })
      .catch(() => {
        if (!mountedRef.current || hintsSeqRef.current !== seq || sessionRef.current !== sessionId)
          return
        setState((current) => ({
          ...current,
          phase: 'hintFailed',
          error: { code: 'UNKNOWN_ERROR', scope: 'hints' }
        }))
      })
  }, [])

  const startRound = useCallback((): void => {
    // 新一轮开启前释放旧会话（含在途调用），旧结果按序号忽略。
    releasePreviousSession()
    hintsSeqRef.current += 1
    reviewSeqRef.current += 1
    const seq = ++startSeqRef.current
    setState({ ...INITIAL_STATE, phase: 'loading' })
    window.api.sentencePractice
      .start({ requestId: crypto.randomUUID() })
      .then((result) => {
        if (!mountedRef.current || startSeqRef.current !== seq) {
          if (result.status === 'ok') {
            void window.api.sentencePractice.close({ sessionId: result.sessionId }).catch(() => {})
          }
          return
        }
        if (result.status === 'error') {
          setState({ ...INITIAL_STATE, error: { code: result.error.code, scope: 'start' } })
          return
        }
        sessionRef.current = result.sessionId
        // 词库不足 3 个：显示实际数量，不发起模型调用。
        if (result.entries.length < 3) {
          setState({
            ...INITIAL_STATE,
            phase: 'empty',
            sessionId: result.sessionId,
            entries: result.entries
          })
          return
        }
        setState({
          ...INITIAL_STATE,
          phase: 'hinting',
          sessionId: result.sessionId,
          entries: result.entries
        })
        requestHints(result.sessionId)
      })
      .catch(() => {
        if (!mountedRef.current || startSeqRef.current !== seq) return
        setState({ ...INITIAL_STATE, error: { code: 'UNKNOWN_ERROR', scope: 'start' } })
      })
  }, [releasePreviousSession, requestHints])

  const regenerateHints = useCallback((): void => {
    const sessionId = sessionRef.current
    // 只有提示失败的轮次可对同一组单词重新生成。
    if (!sessionId || state.phase !== 'hintFailed') return
    requestHints(sessionId)
  }, [state.phase, requestHints])

  const setAnswer = useCallback((value: string): void => {
    setState((current) => {
      if (current.phase !== 'ready' && current.phase !== 'done') return current
      // 修改答案即放弃上一轮点评，需重新提交。
      const reviewed = current.phase === 'done'
      return {
        ...current,
        phase: 'ready',
        answer: value,
        ...(reviewed ? { review: undefined } : {})
      }
    })
  }, [])

  const submit = useCallback((): void => {
    const sessionId = sessionRef.current
    if (!sessionId || state.phase !== 'ready') return
    const answer = state.answer.trim()
    if (!answer) return
    const requestId = crypto.randomUUID()
    activeRequestIdRef.current = requestId
    const seq = ++reviewSeqRef.current
    setState((current) => ({ ...current, phase: 'reviewing', error: undefined, notice: undefined }))
    window.api.sentencePractice
      .review({ requestId, sessionId, answer })
      .then((result) => {
        if (!mountedRef.current || reviewSeqRef.current !== seq) return
        if (result.status === 'error') {
          if (result.error.code === 'CANCELLED') {
            setState((current) => ({ ...current, phase: 'ready', notice: 'cancelled' }))
            return
          }
          setState((current) => ({
            ...current,
            phase: 'ready',
            error: { code: result.error.code, scope: 'review' }
          }))
          return
        }
        setState((current) => ({ ...current, phase: 'done', review: result.review }))
      })
      .catch(() => {
        if (!mountedRef.current || reviewSeqRef.current !== seq) return
        setState((current) => ({
          ...current,
          phase: 'ready',
          error: { code: 'UNKNOWN_ERROR', scope: 'review' }
        }))
      })
  }, [state.phase, state.answer])

  const cancelActive = useCallback((): void => {
    const sessionId = sessionRef.current
    const requestId = activeRequestIdRef.current
    if (!sessionId || !requestId) return
    // 状态切换由被取消请求的 CANCELLED 响应路径完成。
    window.api.sentencePractice
      .cancel({ requestId, sessionId })
      .then(() => undefined)
      .catch(() => {})
  }, [])

  return { state, startRound, regenerateHints, setAnswer, submit, cancelActive }
}
