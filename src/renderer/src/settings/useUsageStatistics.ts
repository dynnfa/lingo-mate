import { useCallback, useRef, useState } from 'react'
import type { UsageErrorCode, UsageOverview } from '../../../shared/usage'

export type UsageDimension = 'daily' | 'weekly'

// idle：Usage 区块尚未激活过；loading：首次读取；ready：已有快照；
// error：首次读取失败且无数据可展示。
export type UsageLoadState = 'idle' | 'loading' | 'ready' | 'error'

// 页面级用量状态：SettingsPage 持有，区块随菜单切换隐藏时
// 维度与选中周保留；刷新失败时保留旧快照并标记数据未更新。
export interface UsageStatisticsState {
  loadState: UsageLoadState
  overview: UsageOverview | undefined
  loadError: UsageErrorCode | undefined
  refreshing: boolean
  dimension: UsageDimension
  selectedWeekKey: string | undefined
  reload: () => void
  setDimension: (dimension: UsageDimension) => void
  selectWeek: (weekKey: string) => void
}

export function useUsageStatistics(): UsageStatisticsState {
  const [loadState, setLoadState] = useState<UsageLoadState>('idle')
  const [overview, setOverview] = useState<UsageOverview | undefined>(undefined)
  const [loadError, setLoadError] = useState<UsageErrorCode | undefined>(undefined)
  const [refreshing, setRefreshing] = useState(false)
  const [dimension, setDimensionState] = useState<UsageDimension>('daily')
  const [selectedWeekKey, setSelectedWeekKey] = useState<string | undefined>(undefined)
  const overviewRef = useRef<UsageOverview | undefined>(undefined)
  // 请求序号：快速切换、重复刷新或卸载后的过期响应不覆盖新状态。
  const requestSeqRef = useRef(0)

  const reload = useCallback((): void => {
    const requestSeq = ++requestSeqRef.current
    const isFirstLoad = overviewRef.current === undefined
    if (isFirstLoad) {
      setLoadState('loading')
      setLoadError(undefined)
    } else {
      setRefreshing(true)
    }

    window.api.usage
      .getOverview({})
      .then((result) => {
        if (requestSeqRef.current !== requestSeq) return
        if (result.status === 'ok') {
          const nextOverview = result.overview
          overviewRef.current = nextOverview
          setOverview(nextOverview)
          setLoadError(undefined)
          setLoadState('ready')
          setRefreshing(false)
          // 已选周在新快照中不存在（如跨入新的一周）时回到本周。
          setSelectedWeekKey((current) =>
            current && nextOverview.weeks.some((week) => week.key === current)
              ? current
              : nextOverview.weeks[nextOverview.weeks.length - 1]?.key
          )
          return
        }
        setLoadError(result.error.code)
        setRefreshing(false)
        if (overviewRef.current === undefined) setLoadState('error')
      })
      .catch(() => {
        if (requestSeqRef.current !== requestSeq) return
        setLoadError('UNKNOWN_ERROR')
        setRefreshing(false)
        if (overviewRef.current === undefined) setLoadState('error')
      })
  }, [])

  // 切换统计范围先展示已有快照，再重新读取；周维度默认选中本周。
  const setDimension = useCallback(
    (next: UsageDimension): void => {
      if (next === dimension) return
      setDimensionState(next)
      if (next === 'weekly') {
        const currentOverview = overviewRef.current
        setSelectedWeekKey(
          (selected) => selected ?? currentOverview?.weeks[currentOverview.weeks.length - 1]?.key
        )
      }
      reload()
    },
    [dimension, reload]
  )

  const selectWeek = useCallback((weekKey: string): void => {
    setSelectedWeekKey((current) => (current === weekKey ? current : weekKey))
  }, [])

  return {
    loadState,
    overview,
    loadError,
    refreshing,
    dimension,
    selectedWeekKey,
    reload,
    setDimension,
    selectWeek
  }
}
