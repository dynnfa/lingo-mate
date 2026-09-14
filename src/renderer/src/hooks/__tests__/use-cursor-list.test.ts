// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { useCursorList, type CursorPage } from '../use-cursor-list'

interface Item {
  id: string
}

function page(ids: string[], nextCursor: string | null = null): CursorPage<Item, string> {
  return { entries: ids.map((id) => ({ id })), nextCursor }
}

// 结果按到达顺序排队消费；未预置结果时挂起，模拟慢请求。
function createLoad(): {
  load: (cursor: string | null) => Promise<CursorPage<Item, string>>
  calls: Array<string | null>
  respond: (result: CursorPage<Item, string>) => void
  fail: (error: unknown) => void
} {
  const calls: Array<string | null> = []
  const queue: Array<Promise<CursorPage<Item, string>>> = []
  const errors: Array<unknown> = []
  const load = (cursor: string | null): Promise<CursorPage<Item, string>> => {
    calls.push(cursor)
    const error = errors.shift()
    if (error !== undefined) return Promise.reject(error)
    return queue.shift() ?? new Promise(() => {})
  }
  return {
    load,
    calls,
    respond(result: CursorPage<Item, string>) {
      queue.push(Promise.resolve(result))
    },
    fail(error: unknown) {
      errors.push(error)
    }
  }
}

afterEach(() => {
  cleanup()
})

describe('useCursorList', () => {
  it('loads the first page and reaches ready', async () => {
    const stub = createLoad()
    stub.respond(page(['a']))
    const { result } = renderHook(() =>
      useCursorList<Item, string>({ keyOf: (entry) => entry.id, load: stub.load })
    )

    expect(result.current.phase).toBe('loading')
    await waitFor(() => expect(result.current.phase).toBe('ready'))
    expect(result.current.entries).toEqual([{ id: 'a' }])
    expect(result.current.nextCursor).toBeNull()
    expect(stub.calls).toEqual([null])
  })

  it('captures the first-load error and recovers via reload', async () => {
    const stub = createLoad()
    stub.fail('STORAGE_FAILED')
    const { result } = renderHook(() =>
      useCursorList<Item, string>({ keyOf: (entry) => entry.id, load: stub.load })
    )

    await waitFor(() => expect(result.current.phase).toBe('error'))
    expect(result.current.loadError).toBe('STORAGE_FAILED')

    stub.respond(page(['a']))
    act(() => result.current.reload())
    await waitFor(() => expect(result.current.phase).toBe('ready'))
    expect(result.current.entries).toEqual([{ id: 'a' }])
    expect(stub.calls).toEqual([null, null])
  })

  it('appends pages through loadMore with dedup and clears moreError on retry', async () => {
    const stub = createLoad()
    stub.respond(page(['a'], 'cursor-1'))
    const { result } = renderHook(() =>
      useCursorList<Item, string>({ keyOf: (entry) => entry.id, load: stub.load })
    )
    await waitFor(() => expect(result.current.phase).toBe('ready'))

    stub.fail('STORAGE_FAILED')
    act(() => result.current.loadMore())
    await waitFor(() => expect(result.current.moreError).toBe('STORAGE_FAILED'))
    expect(result.current.entries).toEqual([{ id: 'a' }])
    expect(result.current.loadingMore).toBe(false)

    // 重试返回重复行 a 与新行 b：重复被去重。
    stub.respond(page(['a', 'b'], 'cursor-2'))
    act(() => result.current.loadMore())
    await waitFor(() => expect(result.current.nextCursor).toBe('cursor-2'))
    expect(result.current.entries).toEqual([{ id: 'a' }, { id: 'b' }])
    expect(result.current.moreError).toBeNull()
    expect(stub.calls).toEqual([null, 'cursor-1', 'cursor-1'])
  })

  it('ignores loadMore without a cursor or while one is in flight', async () => {
    const stub = createLoad()
    stub.respond(page(['a'], 'cursor-1'))
    const { result } = renderHook(() =>
      useCursorList<Item, string>({ keyOf: (entry) => entry.id, load: stub.load })
    )
    await waitFor(() => expect(result.current.phase).toBe('ready'))

    // 无结果预置：请求挂起，loadingMore 保持 true，第二次调用被忽略。
    act(() => result.current.loadMore())
    expect(result.current.loadingMore).toBe(true)
    act(() => result.current.loadMore())
    expect(stub.calls).toEqual([null, 'cursor-1'])
  })

  it('stops offering load more once the cursor is exhausted', async () => {
    const stub = createLoad()
    stub.respond(page(['a']))
    const { result } = renderHook(() =>
      useCursorList<Item, string>({ keyOf: (entry) => entry.id, load: stub.load })
    )
    await waitFor(() => expect(result.current.phase).toBe('ready'))
    expect(result.current.nextCursor).toBeNull()

    act(() => result.current.loadMore())
    expect(stub.calls).toEqual([null])
    expect(result.current.loadingMore).toBe(false)
  })

  it('drops stale load-more responses after a reload', async () => {
    const stub = createLoad()
    stub.respond(page(['a'], 'cursor-1'))
    const { result } = renderHook(() =>
      useCursorList<Item, string>({ keyOf: (entry) => entry.id, load: stub.load })
    )
    await waitFor(() => expect(result.current.phase).toBe('ready'))

    // 加载更多挂起期间触发 reload：晚到的旧响应不得覆盖新状态。
    stub.respond(page(['stale']))
    act(() => result.current.loadMore())
    stub.respond(page(['fresh']))
    act(() => result.current.reload())
    await waitFor(() => expect(result.current.phase).toBe('ready'))
    expect(result.current.entries).toEqual([{ id: 'fresh' }])
    expect(result.current.loadingMore).toBe(false)
  })

  it('filters removed entries from later pages', async () => {
    const stub = createLoad()
    stub.respond(page(['a'], 'cursor-1'))
    const { result } = renderHook(() =>
      useCursorList<Item, string>({ keyOf: (entry) => entry.id, load: stub.load })
    )
    await waitFor(() => expect(result.current.phase).toBe('ready'))

    act(() => result.current.removeEntry('a'))
    expect(result.current.entries).toEqual([])

    // 迟到页面携带已删条目 a 与新条目 b：a 不复活。
    stub.respond(page(['a', 'b']))
    act(() => result.current.loadMore())
    await waitFor(() => expect(result.current.nextCursor).toBeNull())
    expect(result.current.entries).toEqual([{ id: 'b' }])
  })

  it('does not settle state after unmount', async () => {
    const stub = createLoad()
    stub.respond(page(['a']))
    const { unmount } = renderHook(() =>
      useCursorList<Item, string>({ keyOf: (entry) => entry.id, load: stub.load })
    )
    unmount()
    // 卸载后晚到响应被 mounted 防护吞掉，不抛错。
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
  })
})
