import { ExplorePhraseError } from './explore-phrase-error'

// 同一用户数据目录内探索任务的串行锁：跨会话共享，覆盖读取历史、模型生成
// 与提交全程；排队等待期间可被取消，取消不占用锁也不阻塞后续任务。

export class ExplorePhraseSerialLock {
  private tail: Promise<void> = Promise.resolve()

  async run<T>(signal: AbortSignal, operation: () => Promise<T>): Promise<T> {
    const previous = this.tail
    let release!: () => void
    const finished = new Promise<void>((resolve) => {
      release = resolve
    })
    // A cancelled waiter can return immediately, but its successors still wait
    // for the predecessor to finish before entering the critical section.
    this.tail = previous.then(() => finished)
    try {
      await this.waitForSlot(previous, signal)
      return await operation()
    } finally {
      release()
    }
  }

  private async waitForSlot(previous: Promise<void>, signal: AbortSignal): Promise<void> {
    if (signal.aborted) throw new ExplorePhraseError('CANCELLED')
    const aborted = new Promise<never>((_, reject) => {
      const onAbort = (): void => reject(new ExplorePhraseError('CANCELLED'))
      signal.addEventListener('abort', onAbort, { once: true })
      void previous.finally(() => signal.removeEventListener('abort', onAbort))
    })
    await Promise.race([previous, aborted])
    if (signal.aborted) throw new ExplorePhraseError('CANCELLED')
  }
}
