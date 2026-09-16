import { useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { LoadMoreBar } from '../../components/LoadMoreBar'
import { StateBlock } from '../../components/StateBlock'
import { useCursorList } from '../../hooks/useCursorList'
import type { SynonymGroup } from '../../../../shared/synonym'
import { synonymManagementErrorKey, toSynonymManagementError } from './synonym-messages'

// 已记录页 Synonym 详情：读取收藏的近义词分组，每组用独立 tbody 展示。
// 最左列为组释义单元格，跨该组全部词条行合并且在合并区域内水平、垂直居中；
// 组按 id 区分，释义相同但 id 不同的组不合并。列表读取不调用模型；
// 列表状态机由 useCursorList 持有。
export function SynonymDetail(): React.JSX.Element {
  const { t } = useTranslation(['common', 'errors'])

  const loadPage = useCallback(
    async (
      cursor: string | null
    ): Promise<{ entries: SynonymGroup[]; nextCursor: string | null }> => {
      const result = await window.api.synonym.list(cursor === null ? {} : { cursor })
      if (result.status === 'error') throw result.error.code
      return { entries: result.groups, nextCursor: result.nextCursor }
    },
    []
  )

  const list = useCursorList<SynonymGroup, string>({
    keyOf: (group) => group.id,
    load: loadPage
  })

  return (
    <section aria-labelledby="synonym-detail-title" className="synonym-detail">
      <header className="synonym-detail-header">
        <h2 id="synonym-detail-title">{t('recorded.synonym.detailTitle')}</h2>
      </header>

      {list.phase === 'loading' ? (
        <StateBlock
          className="synonym-state"
          message={t('recorded.synonym.loading')}
          variant="loading"
        />
      ) : list.phase === 'error' ? (
        <StateBlock
          className="synonym-state"
          message={t(synonymManagementErrorKey(toSynonymManagementError(list.loadError)))}
          onRetry={list.reload}
          retryLabel={t('recorded.synonym.retry')}
          title={t('recorded.synonym.loadErrorTitle')}
          variant="error"
        />
      ) : list.entries.length === 0 && list.nextCursor === null ? (
        <StateBlock
          className="synonym-state"
          message={t('recorded.synonym.emptyBody')}
          title={t('recorded.synonym.emptyTitle')}
          variant="empty"
        />
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
              {list.entries.map((group) => (
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
          <LoadMoreBar
            error={
              list.moreError !== null
                ? {
                    title: t('recorded.synonym.loadMoreFailed'),
                    message: t(synonymManagementErrorKey(toSynonymManagementError(list.moreError)))
                  }
                : null
            }
            hasMore={list.nextCursor !== null}
            label={t('recorded.synonym.loadMore')}
            loadingLabel={t('recorded.synonym.loadingMore')}
            loadingMore={list.loadingMore}
            onLoadMore={list.loadMore}
            retryLabel={t('recorded.synonym.retry')}
          />
        </>
      )}
    </section>
  )
}
