import { Fragment } from 'react'
import { useTranslation } from 'react-i18next'
import { LoadMoreBar } from '../../components/LoadMoreBar'
import { StateBlock } from '../../components/StateBlock'
import { formatDateTime } from '../../i18n/formatters'
import { normalizeI18nLocale } from '../../i18n'
import {
  toVocabularyMistakesError,
  vocabularyMistakesErrorKey
} from './vocabulary-mistakes-messages'
import { useVocabularyMistakes } from './useVocabularyMistakes'
import type { MistakeHistoryState } from './useVocabularyMistakes'

// 错题集（单词）详情：按词条聚合展示最近错误释义、累计次数与最近时间；
// 行内可展开该词的错误历史并分页加载。列表与历史的读取状态由
// useVocabularyMistakes 持有；模型返回与用户输入内容按纯文本渲染。
export function VocabularyMistakesDetail(): React.JSX.Element {
  const { t, i18n } = useTranslation(['common', 'errors'])
  const locale = normalizeI18nLocale(i18n.resolvedLanguage)
  const { list, histories, toggleHistory, retryHistory, loadMoreHistory } = useVocabularyMistakes()

  const historyId = (entryId: string): string => `vocabulary-mistake-history-${entryId}`

  const renderHistory = (entryId: string, history: MistakeHistoryState): React.JSX.Element => {
    if (history.phase === 'loading') {
      return (
        <p aria-live="polite" className="vocabulary-mistakes-history-status" role="status">
          {t('common:mistakes.vocabulary.historyLoading')}
        </p>
      )
    }
    if (history.phase === 'error') {
      return (
        <div className="vocabulary-mistakes-history-error" role="alert">
          <p>{t('common:mistakes.vocabulary.historyErrorTitle')}</p>
          <button onClick={() => retryHistory(entryId)} type="button">
            {t('common:mistakes.vocabulary.retry')}
          </button>
        </div>
      )
    }
    return (
      <>
        <ul className="vocabulary-mistakes-history-list">
          {history.items.map((item) => (
            <li className="vocabulary-mistakes-history-item" key={item.id}>
              <p className="vocabulary-mistakes-history-meaning">{item.submittedMeaning}</p>
              <time className="vocabulary-mistakes-history-time" dateTime={item.createdAt}>
                {formatDateTime(locale, item.createdAt)}
              </time>
            </li>
          ))}
        </ul>
        <LoadMoreBar
          error={
            history.moreError !== null
              ? {
                  title: t('common:mistakes.vocabulary.historyLoadMoreFailed'),
                  message: t(
                    vocabularyMistakesErrorKey(toVocabularyMistakesError(history.moreError))
                  )
                }
              : null
          }
          hasMore={history.nextCursor !== null}
          label={t('common:mistakes.vocabulary.historyLoadMore')}
          loadingLabel={t('common:mistakes.vocabulary.historyLoadingMore')}
          loadingMore={history.loadingMore}
          onLoadMore={() => loadMoreHistory(entryId)}
          retryLabel={t('common:mistakes.vocabulary.retry')}
        />
      </>
    )
  }

  return (
    <section aria-labelledby="vocabulary-mistakes-title" className="vocabulary-mistakes-detail">
      <header className="vocabulary-mistakes-header">
        <h2 id="vocabulary-mistakes-title">{t('common:mistakes.vocabulary.detailTitle')}</h2>
      </header>

      {list.phase === 'loading' ? (
        <StateBlock
          className="vocabulary-mistakes-state"
          message={t('common:mistakes.vocabulary.loading')}
          variant="loading"
        />
      ) : list.phase === 'error' ? (
        <StateBlock
          className="vocabulary-mistakes-state"
          message={t(vocabularyMistakesErrorKey(toVocabularyMistakesError(list.loadError)))}
          onRetry={list.reload}
          retryLabel={t('common:mistakes.vocabulary.retry')}
          title={t('common:mistakes.vocabulary.loadErrorTitle')}
          variant="error"
        />
      ) : list.entries.length === 0 && list.nextCursor === null ? (
        <StateBlock
          className="vocabulary-mistakes-state"
          message={t('common:mistakes.vocabulary.emptyBody')}
          title={t('common:mistakes.vocabulary.emptyTitle')}
          variant="empty"
        />
      ) : (
        <>
          <div className="vocabulary-mistakes-table-scroll">
            <table className="vocabulary-mistakes-table">
              <caption className="sr-only">{t('common:mistakes.vocabulary.tableCaption')}</caption>
              <thead>
                <tr>
                  <th scope="col">{t('common:mistakes.vocabulary.columnTerm')}</th>
                  <th scope="col">{t('common:mistakes.vocabulary.columnLastMeaning')}</th>
                  <th scope="col">{t('common:mistakes.vocabulary.columnCount')}</th>
                  <th scope="col">{t('common:mistakes.vocabulary.columnLastErrorAt')}</th>
                  <th className="vocabulary-mistakes-actions-column" scope="col">
                    {t('common:mistakes.vocabulary.columnActions')}
                  </th>
                </tr>
              </thead>
              <tbody>
                {list.entries.map((entry) => {
                  const history = histories[entry.entryId]
                  const expanded = history !== undefined
                  return (
                    <Fragment key={entry.entryId}>
                      <tr>
                        <td className="vocabulary-mistakes-term">{entry.term}</td>
                        <td className="vocabulary-mistakes-meaning">
                          {entry.lastSubmittedMeaning}
                        </td>
                        <td className="vocabulary-mistakes-count">
                          {t('common:mistakes.vocabulary.mistakeCount', {
                            count: entry.totalMistakes
                          })}
                        </td>
                        <td className="vocabulary-mistakes-time">
                          <time dateTime={entry.lastErrorAt}>
                            {formatDateTime(locale, entry.lastErrorAt)}
                          </time>
                        </td>
                        <td className="vocabulary-mistakes-actions-column">
                          <button
                            aria-controls={historyId(entry.entryId)}
                            aria-expanded={expanded}
                            aria-label={
                              expanded
                                ? t('common:mistakes.vocabulary.collapseHistoryLabel', {
                                    term: entry.term
                                  })
                                : t('common:mistakes.vocabulary.expandHistoryLabel', {
                                    term: entry.term
                                  })
                            }
                            onClick={() => toggleHistory(entry.entryId)}
                            type="button"
                          >
                            {expanded
                              ? t('common:mistakes.vocabulary.hideHistory')
                              : t('common:mistakes.vocabulary.showHistory')}
                          </button>
                        </td>
                      </tr>
                      {expanded && history ? (
                        <tr className="vocabulary-mistakes-history-row">
                          <td colSpan={5}>
                            <div
                              aria-label={t('common:mistakes.vocabulary.historyLabel', {
                                term: entry.term
                              })}
                              className="vocabulary-mistakes-history"
                              id={historyId(entry.entryId)}
                              role="group"
                            >
                              {renderHistory(entry.entryId, history)}
                            </div>
                          </td>
                        </tr>
                      ) : null}
                    </Fragment>
                  )
                })}
              </tbody>
            </table>
          </div>
          <LoadMoreBar
            error={
              list.moreError !== null
                ? {
                    title: t('common:mistakes.vocabulary.loadMoreFailed'),
                    message: t(
                      vocabularyMistakesErrorKey(toVocabularyMistakesError(list.moreError))
                    )
                  }
                : null
            }
            hasMore={list.nextCursor !== null}
            label={t('common:mistakes.vocabulary.loadMore')}
            loadingLabel={t('common:mistakes.vocabulary.loadingMore')}
            loadingMore={list.loadingMore}
            onLoadMore={list.loadMore}
            retryLabel={t('common:mistakes.vocabulary.retry')}
          />
        </>
      )}
    </section>
  )
}
