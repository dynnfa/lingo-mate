import { useCallback, useEffect, useRef, useState } from 'react'

// 一页游标列表结果：entries 为本页条目，nextCursor 为下一页游标（null 表示取尽）。
export interface CursorPage<TEntry, TCursor> {
  entries: TEntry[]
  nextCursor: TCursor | null
}

export interface UseCursorListOptions<TEntry, TCursor> {
  // 读取一页；失败时抛出错误（通常为领域错误码），由 hook 捕获进 loadError/moreError。
  load: (cursor: TCursor | null) => Promise<CursorPage<TEntry, TCursor>>
  keyOf: (entry: TEntry) => string
}

export interface CursorList<TEntry, TCursor> {
  phase: 'loading' | 'ready' | 'error'
  // 首次读取失败时 load 抛出的错误；调用方沿用各自错误码映射表转文案。
  loadError: unknown
  entries: TEntry[]
  nextCursor: TCursor | null
  loadingMore: boolean
  moreError: unknown | null
  // 读取同步更新的最新列表（含尚未渲染的更新）；删除流程定位相邻行用。
  getEntries: () => readonly TEntry[]
  // 清空后回到初始加载。
  reload: () => void
  // 内置 cursor/loadingMore 守卫与按 key 去重。
  loadMore: () => void
  // 本地移除并记入已删集合，后续加载过滤。
  removeEntry: (key: string) => void
}

// 游标分页列表状态机：吸收卸载防护、过期响应丢弃、追加去重与本地删除过滤。
// 三个 recorded 详情页共享；加载与错误文案映射留在调用方。
export function useCursorList<TEntry, TCursor>(
  options: UseCursorListOptions<TEntry, TCursor>
): CursorList<TEntry, TCursor> {
  const { load, keyOf } = options
  const [phase, setPhase] = useState<'loading' | 'ready' | 'error'>('loading')
  const [entries, setEntries] = useState<TEntry[]>([])
  const [nextCursor, setNextCursor] = useState<TCursor | null>(null)
  const [loadError, setLoadError] = useState<unknown>(undefined)
  const [loadingMore, setLoadingMore] = useState(false)
  const [moreError, setMoreError] = useState<unknown>(null)

  const mountedRef = useRef(true)
  const entriesRef = useRef<TEntry[]>([])
  const nextCursorRef = useRef<TCursor | null>(null)
  const initialSeqRef = useRef(0)
  const moreSeqRef = useRef(0)
  // 本地已删除的条目 key：迟到的列表结果不得让条目重新出现。
  const deletedKeysRef = useRef<Set<string>>(new Set())

  // load/keyOf 经 latest-ref 读取：调用方传入内联函数也不会触发重新加载。
  const loadRef = useRef(load)
  const keyOfRef = useRef(keyOf)
  useEffect(() => {
    loadRef.current = load
    keyOfRef.current = keyOf
  })

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  const applyEntries = useCallback((next: TEntry[]): void => {
    entriesRef.current = next
    setEntries(next)
  }, [])

  const loadList = useCallback((): void => {
    // 新的首次读取同时使在途的加载更多结果过期。
    const seq = ++initialSeqRef.current
    moreSeqRef.current += 1
    loadRef
      .current(null)
      .then((page) => {
        if (!mountedRef.current || initialSeqRef.current !== seq) return
        applyEntries(
          page.entries.filter((entry) => !deletedKeysRef.current.has(keyOfRef.current(entry)))
        )
        nextCursorRef.current = page.nextCursor
        setNextCursor(page.nextCursor)
        setLoadError(undefined)
        setPhase('ready')
      })
      .catch((error: unknown) => {
        if (!mountedRef.current || initialSeqRef.current !== seq) return
        setLoadError(error)
        setPhase('error')
      })
  }, [applyEntries])

  useEffect(() => {
    loadList()
  }, [loadList])

  // 重试由用户事件触发：先回到 loading 再发起读取；同时复位加载更多状态，
  // 避免被过期守卫丢弃的响应把 loadingMore 永久留在 true。
  const reload = useCallback((): void => {
    setPhase('loading')
    setLoadError(undefined)
    setMoreError(null)
    setLoadingMore(false)
    loadList()
  }, [loadList])

  const loadMore = useCallback((): void => {
    const cursor = nextCursorRef.current
    if (cursor === null || loadingMore) return
    const seq = ++moreSeqRef.current
    setLoadingMore(true)
    setMoreError(null)
    loadRef
      .current(cursor)
      .then((page) => {
        if (!mountedRef.current || moreSeqRef.current !== seq) return
        setLoadingMore(false)
        // 追加时同时跳过本地已删除的 key 与当前已展示的重复行。
        const current = entriesRef.current
        const seen = new Set(current.map(keyOfRef.current))
        const fresh = page.entries.filter(
          (entry) =>
            !deletedKeysRef.current.has(keyOfRef.current(entry)) &&
            !seen.has(keyOfRef.current(entry))
        )
        applyEntries([...current, ...fresh])
        nextCursorRef.current = page.nextCursor
        setNextCursor(page.nextCursor)
      })
      .catch((error: unknown) => {
        if (!mountedRef.current || moreSeqRef.current !== seq) return
        setLoadingMore(false)
        setMoreError(error)
      })
  }, [applyEntries, loadingMore])

  const removeEntry = useCallback(
    (key: string): void => {
      deletedKeysRef.current.add(key)
      applyEntries(entriesRef.current.filter((entry) => keyOfRef.current(entry) !== key))
    },
    [applyEntries]
  )

  const getEntries = useCallback((): readonly TEntry[] => entriesRef.current, [])

  return {
    phase,
    loadError,
    entries,
    nextCursor,
    loadingMore,
    moreError,
    getEntries,
    reload,
    loadMore,
    removeEntry
  }
}
