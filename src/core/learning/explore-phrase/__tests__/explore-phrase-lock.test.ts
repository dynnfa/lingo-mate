import { describe, expect, it, vi } from 'vitest'
import { ExplorePhraseSerialLock } from '../explore-phrase-lock'

describe('ExplorePhraseSerialLock', () => {
  it('keeps later work behind the active operation when a queued waiter cancels', async () => {
    const lock = new ExplorePhraseSerialLock()
    let finishFirst!: () => void
    const first = lock.run(
      new AbortController().signal,
      () =>
        new Promise<void>((resolve) => {
          finishFirst = resolve
        })
    )
    await vi.waitFor(() => expect(finishFirst).toBeDefined())
    const controller = new AbortController()
    const cancelledWork = vi.fn()
    const second = lock.run(controller.signal, cancelledWork)
    controller.abort()
    await expect(second).rejects.toMatchObject({ code: 'CANCELLED' })
    const thirdWork = vi.fn()
    const third = lock.run(new AbortController().signal, thirdWork)
    try {
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(thirdWork).not.toHaveBeenCalled()
      expect(cancelledWork).not.toHaveBeenCalled()
    } finally {
      finishFirst()
      await Promise.all([first, third])
    }
    expect(thirdWork).toHaveBeenCalledOnce()
  })
})
