import { useCallback, useEffect, useRef, useState } from 'react'

export interface UseIpcRequestHandlers<TResult> {
  onComplete?: (result: TResult) => void
  onError?: (error: unknown) => void
}

export interface UseIpcRequest<TArgs extends unknown[], TResult> {
  pending: boolean
  // 调用方沿用各自错误码映射表转文案。
  error: unknown | null
  // pending 期间静默忽略（防双击）；返回请求结果，失败或被忽略时为 null。
  run: (...args: TArgs) => Promise<TResult | null>
  reset: () => void
}

// 单向请求防护：pending 守卫、卸载后不落盘 state、错误捕获。
// 请求函数与回调经 latest-ref 读取，内联箭头函数不会改变 run 的身份。
export function useIpcRequest<TArgs extends unknown[], TResult>(
  request: (...args: TArgs) => Promise<TResult>,
  handlers?: UseIpcRequestHandlers<TResult>
): UseIpcRequest<TArgs, TResult> {
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<unknown | null>(null)
  const mountedRef = useRef(true)
  const inFlightRef = useRef(false)
  const requestRef = useRef(request)
  const handlersRef = useRef(handlers)

  useEffect(() => {
    requestRef.current = request
    handlersRef.current = handlers
  })

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  const run = useCallback(async (...args: TArgs): Promise<TResult | null> => {
    if (inFlightRef.current) return null
    inFlightRef.current = true
    setPending(true)
    setError(null)
    try {
      const result = await requestRef.current(...args)
      if (!mountedRef.current) return result
      // 等待回调（可能为 async）完成后再复位 pending，与调用方 finally 语义对齐。
      await handlersRef.current?.onComplete?.(result)
      return result
    } catch (thrown) {
      if (mountedRef.current) {
        setError(thrown)
        handlersRef.current?.onError?.(thrown)
      }
      return null
    } finally {
      inFlightRef.current = false
      if (mountedRef.current) setPending(false)
    }
  }, [])

  const reset = useCallback((): void => {
    setPending(false)
    setError(null)
  }, [])

  return { pending, error, run, reset }
}
