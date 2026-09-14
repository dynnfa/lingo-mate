// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { useIpcRequest } from '../use-ipc-request'

afterEach(() => {
  cleanup()
})

describe('useIpcRequest', () => {
  it('tracks pending, returns the result and invokes onComplete', async () => {
    const onComplete = vi.fn()
    const request = vi.fn(async (value: number): Promise<number> => value * 2)
    const { result } = renderHook(() => useIpcRequest(request, { onComplete }))

    expect(result.current.pending).toBe(false)
    let resolved: number | null | undefined
    act(() => {
      void result.current.run(21).then((value) => {
        resolved = value
      })
    })
    expect(result.current.pending).toBe(true)
    await waitFor(() => expect(result.current.pending).toBe(false))
    expect(resolved).toBe(42)
    expect(onComplete).toHaveBeenCalledWith(42)
    expect(result.current.error).toBeNull()
  })

  it('captures thrown errors and reports them via onError', async () => {
    const onError = vi.fn()
    const request = vi.fn(async (): Promise<never> => {
      throw 'STORAGE_FAILED'
    })
    const { result } = renderHook(() => useIpcRequest(request, { onError }))

    let resolved: unknown = 'unset'
    await act(async () => {
      resolved = await result.current.run()
    })
    expect(resolved).toBeNull()
    expect(result.current.error).toBe('STORAGE_FAILED')
    expect(onError).toHaveBeenCalledWith('STORAGE_FAILED')
    expect(result.current.pending).toBe(false)
  })

  it('silently ignores re-entry while a request is pending', async () => {
    let resolveFirst: (value: string) => void = () => {}
    const request = vi.fn(
      (suffix: string): Promise<string> =>
        new Promise((resolve) => {
          if (suffix === 'first') resolveFirst = resolve
          else resolve(suffix)
        })
    )
    const { result } = renderHook(() => useIpcRequest(request))

    act(() => {
      void result.current.run('first')
    })
    let second: string | null | undefined
    await act(async () => {
      second = await result.current.run('second')
    })
    expect(second).toBeNull()
    expect(request).toHaveBeenCalledTimes(1)

    await act(async () => {
      resolveFirst('done')
    })
    await waitFor(() => expect(result.current.pending).toBe(false))
    // 复位后可再次发起。
    let retried: string | null | undefined
    await act(async () => {
      retried = await result.current.run('again')
    })
    expect(retried).toBe('again')
  })

  it('awaits async onComplete before clearing pending', async () => {
    let handlerDone = false
    const request = vi.fn(async (): Promise<string> => 'ok')
    const onComplete = vi.fn(async (): Promise<void> => {
      await new Promise((resolve) => setTimeout(resolve, 10))
      handlerDone = true
    })
    const { result } = renderHook(() => useIpcRequest(request, { onComplete }))

    act(() => {
      void result.current.run()
    })
    await waitFor(() => expect(result.current.pending).toBe(false))
    expect(handlerDone).toBe(true)
  })

  it('reset clears pending and the captured error', async () => {
    const request = vi.fn(async (): Promise<never> => {
      throw 'UNKNOWN_ERROR'
    })
    const { result } = renderHook(() => useIpcRequest(request))
    await act(async () => {
      await result.current.run()
    })
    expect(result.current.error).toBe('UNKNOWN_ERROR')

    act(() => result.current.reset())
    expect(result.current.error).toBeNull()
    expect(result.current.pending).toBe(false)
  })

  it('does not settle state after unmount', async () => {
    let resolveRequest: (value: string) => void = () => {}
    const request = vi.fn(
      (): Promise<string> =>
        new Promise((resolve) => {
          resolveRequest = resolve
        })
    )
    const { result, unmount } = renderHook(() => useIpcRequest(request))
    act(() => {
      void result.current.run()
    })
    unmount()
    // 卸载后晚到响应不触发 setState，也不抛错。
    await act(async () => {
      resolveRequest('late')
      await Promise.resolve()
    })
  })
})
