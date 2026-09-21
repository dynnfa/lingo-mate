// 两种探索技能（explore-phrase / explore-vocabulary）共享的串行锁：同一用户
// 数据目录内同一技能的探索任务串行，覆盖读取历史、模型生成与提交全程；
// 排队等待期间可被取消，取消不占用锁也不阻塞后续任务。取消错误类型由
// 各技能注入；两个技能使用各自的锁实例，互不排队。

export class ExploreSerialLock {
  private tail: Promise<void> = Promise.resolve()

  constructor(private readonly cancelledError: () => Error) {}

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
    if (signal.aborted) throw this.cancelledError()
    const aborted = new Promise<never>((_, reject) => {
      const onAbort = (): void => reject(this.cancelledError())
      signal.addEventListener('abort', onAbort, { once: true })
      void previous.finally(() => signal.removeEventListener('abort', onAbort))
    })
    await Promise.race([previous, aborted])
    if (signal.aborted) throw this.cancelledError()
  }
}
