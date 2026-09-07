import { VocabularyError } from './parse-vocabulary-input'

// Race independently of the SDK: even an adapter that ignores AbortSignal cannot
// keep the caller pending or have its late result accepted. Always abort the transport.
export async function abortableOperation<T>(
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
        parent.reason instanceof VocabularyError ? parent.reason : new VocabularyError('CANCELLED')
      controller.abort(error)
      reject(error)
    }
    if (parent.aborted) {
      onAbort()
      return
    }
    parent.addEventListener('abort', onAbort, { once: true })
    timer = setTimeout(() => {
      const error = new VocabularyError('TIMEOUT')
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
