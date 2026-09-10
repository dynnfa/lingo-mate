import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { SynonymGroup, SynonymManagementErrorCode } from '../../../../shared/synonym'
import { synonymManagementErrorKey } from './synonym-messages'

type SynonymLoadState = 'loading' | 'ready' | 'error'

// 已记录页 Synonym 详情：读取收藏的近义词分组，每组用独立 tbody 展示。
// 最左列为组释义单元格，跨该组全部词条行合并且在合并区域内水平、垂直居中；
// 组按 id 区分，释义相同但 id 不同的组不合并。列表读取不调用模型。
export function SynonymDetail(): React.JSX.Element {
  const { t } = useTranslation(['common', 'errors'])

  const [loadState, setLoadState] = useState<SynonymLoadState>('loading')
  const [groups, setGroups] = useState<SynonymGroup[]>([])
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [loadError, setLoadError] = useState<SynonymManagementErrorCode | undefined>(undefined)
  const [loadingMore, setLoadingMore] = useState(false)
  const [moreError, setMoreError] = useState<SynonymManagementErrorCode | undefined>(undefined)

  const mountedRef = useRef(true)
  const groupsRef = useRef<SynonymGroup[]>([])
  const nextCursorRef = useRef<string | null>(null)
  const initialSeqRef = useRef(0)
  const moreSeqRef = useRef(0)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  const applyGroups = useCallback((next: SynonymGroup[]): void => {
    groupsRef.current = next
    setGroups(next)
  }, [])

  const loadList = useCallback((): void => {
    // 新的首次读取同时使在途的加载更多结果过期。
    const seq = ++initialSeqRef.current
    moreSeqRef.current += 1
    window.api.synonym
      .list({})
      .then((result) => {
        if (!mountedRef.current || initialSeqRef.current !== seq) return
        if (result.status === 'error') {
          setLoadError(result.error.code)
          setLoadState('error')
          return
        }
        applyGroups(result.groups)
        nextCursorRef.current = result.nextCursor
        setNextCursor(result.nextCursor)
        setLoadState('ready')
      })
      .catch(() => {
        if (!mountedRef.current || initialSeqRef.current !== seq) return
        setLoadError('UNKNOWN_ERROR')
        setLoadState('error')
      })
  }, [applyGroups])

  useEffect(() => {
    loadList()
  }, [loadList])

  // 重试由用户事件触发：先回到 loading 再发起读取。
  const reload = useCallback((): void => {
    setLoadState('loading')
    setLoadError(undefined)
    setMoreError(undefined)
    loadList()
  }, [loadList])

  const loadMore = useCallback((): void => {
    const cursor = nextCursorRef.current
    if (!cursor || loadingMore) return
    const seq = ++moreSeqRef.current
    setLoadingMore(true)
    setMoreError(undefined)
    window.api.synonym
      .list({ cursor })
      .then((result) => {
        if (!mountedRef.current || moreSeqRef.current !== seq) return
        setLoadingMore(false)
        if (result.status === 'error') {
          setMoreError(result.error.code)
          return
        }
        // 追加时按组 ID 去重，同一组不重复渲染。
        const current = groupsRef.current
        const seen = new Set(current.map((group) => group.id))
        const fresh = result.groups.filter((group) => !seen.has(group.id))
        applyGroups([...current, ...fresh])
        nextCursorRef.current = result.nextCursor
        setNextCursor(result.nextCursor)
      })
      .catch(() => {
        if (!mountedRef.current || moreSeqRef.current !== seq) return
        setLoadingMore(false)
        setMoreError('UNKNOWN_ERROR')
      })
  }, [applyGroups, loadingMore])

  return (
    <section aria-labelledby="synonym-detail-title" className="synonym-detail">
      <header className="synonym-detail-header">
        <h2 id="synonym-detail-title">{t('recorded.synonym.detailTitle')}</h2>
      </header>

      {loadState === 'loading' ? (
        <div aria-busy="true" className="synonym-state" role="status">
          {t('recorded.synonym.loading')}
        </div>
      ) : loadState === 'error' ? (
        <div className="synonym-state" role="alert">
          <p className="synonym-state-title">{t('recorded.synonym.loadErrorTitle')}</p>
          <p>{t(synonymManagementErrorKey(loadError ?? 'UNKNOWN_ERROR'))}</p>
          <button onClick={reload} type="button">
            {t('recorded.synonym.retry')}
          </button>
        </div>
      ) : groups.length === 0 && !nextCursor ? (
        <div className="synonym-state">
          <p className="synonym-state-title">{t('recorded.synonym.emptyTitle')}</p>
          <p>{t('recorded.synonym.emptyBody')}</p>
        </div>
      ) : (
        <>
          <div className="synonym-table-scroll">
            <table className="synonym-table">
              <caption className="sr-only">{t('recorded.synonym.tableCaption')}</caption>
              <thead>
                <tr>
                  <th scope="col">{t('recorded.synonym.columnGroupMeaning')}</th>
                  <th scope="col">{t('recorded.synonym.columnWord')}</th>
                  <th scope="col">{t('recorded.synonym.columnMeaning')}</th>
                  <th scope="col">{t('recorded.synonym.columnDistinction')}</th>
                </tr>
              </thead>
              {groups.map((group) => (
                <tbody key={group.id}>
                  {group.words.map((entry, index) => (
                    <tr key={entry.id}>
                      {index === 0 ? (
                        <th
                          className="synonym-group-meaning"
                          rowSpan={group.words.length}
                          scope="rowgroup"
                        >
                          {group.meaning}
                        </th>
                      ) : null}
                      <td className="synonym-cell-word">{entry.word}</td>
                      <td className="synonym-cell-prewrap">{entry.meaning}</td>
                      <td className="synonym-cell-prewrap">{entry.distinction}</td>
                    </tr>
                  ))}
                </tbody>
              ))}
            </table>
          </div>
          <footer className="synonym-footer">
            {moreError ? (
              <div className="synonym-more-error" role="alert">
                <p className="synonym-state-title">{t('recorded.synonym.loadMoreFailed')}</p>
                <p>{t(synonymManagementErrorKey(moreError))}</p>
                <button disabled={loadingMore} onClick={loadMore} type="button">
                  {t('recorded.synonym.retry')}
                </button>
              </div>
            ) : null}
            {loadingMore ? (
              <p aria-live="polite" className="synonym-footer-status" role="status">
                {t('recorded.synonym.loadingMore')}
              </p>
            ) : nextCursor ? (
              <button className="synonym-load-more-button" onClick={loadMore} type="button">
                {t('recorded.synonym.loadMore')}
              </button>
            ) : null}
          </footer>
        </>
      )}
    </section>
  )
}
