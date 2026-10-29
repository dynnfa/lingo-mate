// Same-key requests wait through the actual commit. Cancelled waiters cannot
// let their successors overtake a still-running predecessor.
export class SentenceLock {
  private readonly queues = new Map<string, { tail: Promise<void>; users: number }>()
  async run<T>(key: string, signal: AbortSignal, operation: () => Promise<T>): Promise<T> {
    signal.throwIfAborted()
    const queue = this.queues.get(key) ?? { tail: Promise.resolve(), users: 0 }
    this.queues.set(key, queue)
    queue.users++
    const previous = queue.tail
    let release!: () => void
    const finished = new Promise<void>((resolve) => {
      release = resolve
    })
    queue.tail = previous.then(() => finished)
    let abort!: () => void
    const cancelled = new Promise<never>((_, reject) => {
      abort = () => reject(signal.reason ?? new DOMException('Aborted', 'AbortError'))
      signal.addEventListener('abort', abort, { once: true })
    })
    try {
      await Promise.race([previous, cancelled])
      signal.throwIfAborted()
      return await operation()
    } finally {
      signal.removeEventListener('abort', abort)
      release()
      // Keep the queue until predecessors and successors have drained.
      void queue.tail.then(() => {
        if (--queue.users === 0 && this.queues.get(key) === queue) this.queues.delete(key)
      })
    }
  }
}
