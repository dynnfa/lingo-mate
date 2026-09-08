import { PhraseError } from './parse-phrase-input'

// 与 vocabulary 领域同构的通信守卫：即使适配器忽略 AbortSignal，也不能让调用方
// 一直等待或接受迟到结果。始终中止底层传输。
export async function abortablePhraseOperation<T>(
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
        parent.reason instanceof PhraseError ? parent.reason : new PhraseError('CANCELLED')
      controller.abort(error)
      reject(error)
    }
    if (parent.aborted) {
      onAbort()
      return
    }
    parent.addEventListener('abort', onAbort, { once: true })
    timer = setTimeout(() => {
      const error = new PhraseError('TIMEOUT')
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
