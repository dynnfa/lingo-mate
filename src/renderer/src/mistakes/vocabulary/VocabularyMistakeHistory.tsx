import { useTranslation } from 'react-i18next'
import type {
  VocabularyMistakeHistoryCursor,
  VocabularyMistakeHistoryItem
} from '../../../../shared/vocabulary-mistakes'
import { LoadMoreBar } from '../../components/LoadMoreBar'
import { formatDateTime } from '../../i18n/formatters'
import { normalizeI18nLocale } from '../../i18n'
import { useCursorList } from '../../hooks/useCursorList'
import {
  toVocabularyMistakesError,
  vocabularyMistakesErrorKey
} from './vocabulary-mistakes-messages'

// 单个词条的错误历史：挂载即读取首屏，卸载即丢弃全部分页状态，
// 重新展开随重新挂载重新读取。分页状态机复用 useCursorList；
// id 由父级传入以对应展开按钮的 aria-controls。
export function VocabularyMistakeHistory(props: {
  entryId: string
  id: string
  term: string
}): React.JSX.Element {
  const { t, i18n } = useTranslation(['common', 'errors'])
  const locale = normalizeI18nLocale(i18n.resolvedLanguage)
  const history = useCursorList<VocabularyMistakeHistoryItem, VocabularyMistakeHistoryCursor>({
    keyOf: (entry) => entry.id,
    load: async (cursor) => {
      const result = await window.api.vocabularyMistakes.listHistory(
        cursor === null ? { entryId: props.entryId } : { entryId: props.entryId, cursor }
      )
      if (result.status === 'error') throw result.error.code
      return { entries: result.items, nextCursor: result.nextCursor ?? null }
    }
  })

  return (
    <div
      aria-label={t('common:mistakes.vocabulary.historyLabel', { term: props.term })}
      className="vocabulary-mistakes-history"
      id={props.id}
      role="group"
    >
      {history.phase === 'loading' ? (
        <p aria-live="polite" className="vocabulary-mistakes-history-status" role="status">
          {t('common:mistakes.vocabulary.historyLoading')}
        </p>
      ) : history.phase === 'error' ? (
        <div className="vocabulary-mistakes-history-error" role="alert">
          <p>{t('common:mistakes.vocabulary.historyErrorTitle')}</p>
          <button onClick={history.reload} type="button">
            {t('common:mistakes.vocabulary.retry')}
          </button>
        </div>
      ) : (
        <>
          <ul className="vocabulary-mistakes-history-list">
            {history.entries.map((item) => (
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
            onLoadMore={history.loadMore}
            retryLabel={t('common:mistakes.vocabulary.retry')}
          />
        </>
      )}
    </div>
  )
}
