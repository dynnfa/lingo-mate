// 跨学习领域的通信守卫：即使适配器忽略 AbortSignal，也不能让调用方一直
// 等待或接受迟到结果。始终中止底层传输；取消/超时使用领域错误类构造，
// 父信号携带的同领域错误原样透传。
export function createAbortableOperation<E extends Error>(
  DomainError: new (code: 'CANCELLED' | 'TIMEOUT', options?: ErrorOptions) => E
) {
  return async function abortableOperation<T>(
    parent: AbortSignal,
    timeoutMs: number,
    operation: (signal: AbortSignal) => Promise<T>
  ): Promise<T> {
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    let onAbort: () => void = () => {}
    const interrupted = new Promise<never>((_, reject) => {
      onAbort = () => {
        clearTimeout(timer)
        parent.removeEventListener('abort', onAbort)
        const error =
          parent.reason instanceof DomainError ? parent.reason : new DomainError('CANCELLED')
        controller.abort(error)
        reject(error)
      }
      if (parent.aborted) {
        onAbort()
        return
      }
      parent.addEventListener('abort', onAbort, { once: true })
      timer = setTimeout(() => {
        const error = new DomainError('TIMEOUT')
        controller.abort(error)
        reject(error)
      }, timeoutMs)
    })
    try {
      return await Promise.race([
        interrupted,
        Promise.resolve().then(() => {
          if (controller.signal.aborted) throw controller.signal.reason
          return operation(controller.signal)
        })
      ])
    } finally {
      clearTimeout(timer)
      parent.removeEventListener('abort', onAbort)
      controller.abort()
    }
  }
}
