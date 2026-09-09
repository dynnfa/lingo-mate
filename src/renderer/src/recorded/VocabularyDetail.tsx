import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { normalizeI18nLocale } from '../i18n'
import { formatDateTime } from '../i18n/formatters'
import type {
  VocabularyCursor,
  VocabularyEntry,
  VocabularyManagementErrorCode
} from '../../../shared/vocabulary'
import { vocabularyManagementErrorKey } from './vocabulary-messages'

type VocabularyLoadState = 'loading' | 'ready' | 'error'

// 已记录页 Vocabulary 详情：读取收藏词汇以表格展示，最右侧操作列支持
// 按 id 单条删除。请求与删除状态集中在本组件，不经由对话控制器。
export function VocabularyDetail(): React.JSX.Element {
  const { t, i18n } = useTranslation(['common', 'errors'])
  const locale = normalizeI18nLocale(i18n.resolvedLanguage)

  const [loadState, setLoadState] = useState<VocabularyLoadState>('loading')
  const [entries, setEntries] = useState<VocabularyEntry[]>([])
  const [nextCursor, setNextCursor] = useState<VocabularyCursor | undefined>(undefined)
  const [loadError, setLoadError] = useState<VocabularyManagementErrorCode | undefined>(undefined)
  const [loadingMore, setLoadingMore] = useState(false)
  const [moreError, setMoreError] = useState<VocabularyManagementErrorCode | undefined>(undefined)
  const [confirmEntry, setConfirmEntry] = useState<VocabularyEntry | undefined>(undefined)
  const [deleting, setDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState<VocabularyManagementErrorCode | undefined>(
    undefined
  )
  const [deletedTerm, setDeletedTerm] = useState<string | undefined>(undefined)

  const mountedRef = useRef(true)
  const entriesRef = useRef<VocabularyEntry[]>([])
  const nextCursorRef = useRef<VocabularyCursor | undefined>(undefined)
  const initialSeqRef = useRef(0)
  const moreSeqRef = useRef(0)
  // 本地已删除的记录 ID：迟到的列表结果不得让词条重新出现。
  const deletedIdsRef = useRef<Set<string>>(new Set())
  const rowActionRefs = useRef(new Map<string, HTMLButtonElement>())
  const headingRef = useRef<HTMLHeadingElement>(null)
  const pendingFocusRef = useRef<{ rowId?: string } | undefined>(undefined)
  const dialogReturnButtonRef = useRef<HTMLButtonElement | null>(null)
  const cancelButtonRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  const applyEntries = useCallback((next: VocabularyEntry[]): void => {
    entriesRef.current = next
    setEntries(next)
  }, [])

  const loadList = useCallback((): void => {
    // 新的首次读取同时使在途的加载更多结果过期。
    const seq = ++initialSeqRef.current
    moreSeqRef.current += 1
    window.api.vocabulary
      .list({})
      .then((result) => {
        if (!mountedRef.current || initialSeqRef.current !== seq) return
        if (result.status === 'error') {
          setLoadError(result.error.code)
          setLoadState('error')
          return
        }
        applyEntries(result.entries.filter((entry) => !deletedIdsRef.current.has(entry.id)))
        nextCursorRef.current = result.nextCursor
        setNextCursor(result.nextCursor)
        setLoadState('ready')
      })
      .catch(() => {
        if (!mountedRef.current || initialSeqRef.current !== seq) return
        setLoadError('UNKNOWN_ERROR')
        setLoadState('error')
      })
  }, [applyEntries])

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
    window.api.vocabulary
      .list({ cursor })
      .then((result) => {
        if (!mountedRef.current || moreSeqRef.current !== seq) return
        setLoadingMore(false)
        if (result.status === 'error') {
          setMoreError(result.error.code)
          return
        }
        // 追加时同时跳过本地已删除的 ID 与当前已展示的重复行。
        const current = entriesRef.current
        const seen = new Set(current.map((entry) => entry.id))
        const fresh = result.entries.filter(
          (entry) => !deletedIdsRef.current.has(entry.id) && !seen.has(entry.id)
        )
        applyEntries([...current, ...fresh])
        nextCursorRef.current = result.nextCursor
        setNextCursor(result.nextCursor)
      })
      .catch(() => {
        if (!mountedRef.current || moreSeqRef.current !== seq) return
        setLoadingMore(false)
        setMoreError('UNKNOWN_ERROR')
      })
  }, [applyEntries, loadingMore])

  const openDeleteDialog = useCallback(
    (entry: VocabularyEntry, button: HTMLButtonElement): void => {
      dialogReturnButtonRef.current = button
      setDeleteError(undefined)
      setConfirmEntry(entry)
    },
    []
  )

  // 对话框打开后焦点移入；关闭后回到触发按钮，成功删除后移至相邻行或标题。
  useEffect(() => {
    if (confirmEntry) cancelButtonRef.current?.focus()
  }, [confirmEntry])

  const closeDialog = useCallback((): void => {
    if (deleting) return
    setConfirmEntry(undefined)
    setDeleteError(undefined)
    dialogReturnButtonRef.current?.focus()
  }, [deleting])

  const requestDelete = useCallback(
    (entry: VocabularyEntry): void => {
      if (deleting) return
      setDeleting(true)
      setDeleteError(undefined)
      window.api.vocabulary
        .delete({ id: entry.id })
        .then((result) => {
          if (!mountedRef.current) return
          if (result.status === 'error') {
            setDeleteError(result.error.code)
            setDeleting(false)
            return
          }
          // deleted 为 false 表示目标已不存在，同样移除过期行，保证幂等。
          const current = entriesRef.current
          const index = current.findIndex((item) => item.id === entry.id)
          const neighbor = current[index + 1] ?? current[index - 1]
          pendingFocusRef.current = neighbor ? { rowId: neighbor.id } : {}
          deletedIdsRef.current.add(entry.id)
          applyEntries(current.filter((item) => item.id !== entry.id))
          setConfirmEntry(undefined)
          setDeleting(false)
          setDeletedTerm(entry.term)
        })
        .catch(() => {
          if (!mountedRef.current) return
          setDeleteError('UNKNOWN_ERROR')
          setDeleting(false)
        })
    },
    [applyEntries, deleting]
  )

  // 行移除渲染完成后，把焦点交还给相邻行的删除按钮或详情标题。
  useEffect(() => {
    const target = pendingFocusRef.current
    if (!target) return
    pendingFocusRef.current = undefined
    if (target.rowId) rowActionRefs.current.get(target.rowId)?.focus()
    else headingRef.current?.focus()
  }, [entries])

  const handleDialogKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== 'Escape' || deleting) return
    // Escape 只关闭对话框，不冒泡触发已记录页退出。
    event.preventDefault()
    event.stopPropagation()
    closeDialog()
  }

  const setRowActionRef = useCallback((id: string, button: HTMLButtonElement | null): void => {
    if (button) rowActionRefs.current.set(id, button)
    else rowActionRefs.current.delete(id)
  }, [])

  const emptyValue = t('recorded.vocabulary.emptyValue')
  const missing = (key?: string | null): React.JSX.Element | string =>
    key ?? <span className="vocabulary-missing">{emptyValue}</span>

  return (
    <section aria-labelledby="vocabulary-detail-title" className="vocabulary-detail">
      <header className="vocabulary-detail-header">
        <h2 id="vocabulary-detail-title" ref={headingRef} tabIndex={-1}>
          {t('recorded.vocabulary.detailTitle')}
        </h2>
      </header>

      {loadState === 'loading' ? (
        <div aria-busy="true" className="vocabulary-state" role="status">
          {t('recorded.vocabulary.loading')}
        </div>
      ) : loadState === 'error' ? (
        <div className="vocabulary-state" role="alert">
          <p className="vocabulary-state-title">{t('recorded.vocabulary.loadErrorTitle')}</p>
          <p>{t(vocabularyManagementErrorKey(loadError ?? 'UNKNOWN_ERROR'))}</p>
          <button onClick={reload} type="button">
            {t('recorded.vocabulary.retry')}
          </button>
        </div>
      ) : entries.length === 0 && !nextCursor ? (
        <div className="vocabulary-state">
          <p className="vocabulary-state-title">{t('recorded.vocabulary.emptyTitle')}</p>
          <p>{t('recorded.vocabulary.emptyBody')}</p>
        </div>
      ) : (
        <>
          <div className="vocabulary-table-scroll">
            <table className="vocabulary-table">
              <caption className="sr-only">{t('recorded.vocabulary.tableCaption')}</caption>
              <thead>
                <tr>
                  <th scope="col">{t('recorded.vocabulary.columnTerm')}</th>
                  <th scope="col">{t('recorded.vocabulary.columnPhonetic')}</th>
                  <th scope="col">{t('recorded.vocabulary.columnMeaning')}</th>
                  <th scope="col">{t('recorded.vocabulary.columnConcept')}</th>
                  <th scope="col">{t('recorded.vocabulary.columnExamples')}</th>
                  <th scope="col">{t('recorded.vocabulary.columnCreatedAt')}</th>
                  <th className="vocabulary-actions-column" scope="col">
                    {t('recorded.vocabulary.columnActions')}
                  </th>
                </tr>
              </thead>
              <tbody>
                {entries.map((entry) => (
                  <tr key={entry.id}>
                    <td className="vocabulary-cell-term">{entry.term}</td>
                    <td className="vocabulary-cell-phonetic">{missing(entry.phonetic)}</td>
                    <td className="vocabulary-cell-prewrap">{missing(entry.meaning)}</td>
                    <td className="vocabulary-cell-prewrap">{missing(entry.concept)}</td>
                    <td className="vocabulary-cell-examples">
                      {entry.exampleSentences ? (
                        <ul className="vocabulary-example-list">
                          {entry.exampleSentences.map((sentence) => (
                            <li key={sentence}>{sentence}</li>
                          ))}
                        </ul>
                      ) : (
                        missing()
                      )}
                    </td>
                    <td className="vocabulary-cell-date">
                      {formatDateTime(locale, entry.createdAt)}
                    </td>
                    <td className="vocabulary-actions-column vocabulary-actions-cell">
                      <button
                        aria-label={t('recorded.vocabulary.deleteButtonLabel', {
                          term: entry.term
                        })}
                        className="vocabulary-delete-button"
                        onClick={(event) => openDeleteDialog(entry, event.currentTarget)}
                        ref={(button) => setRowActionRef(entry.id, button)}
                        type="button"
                      >
                        {t('recorded.vocabulary.deleteButton')}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <footer className="vocabulary-footer">
            {moreError ? (
              <div className="vocabulary-more-error" role="alert">
                <p className="vocabulary-state-title">{t('recorded.vocabulary.loadMoreFailed')}</p>
                <p>{t(vocabularyManagementErrorKey(moreError))}</p>
                <button disabled={loadingMore} onClick={loadMore} type="button">
                  {t('recorded.vocabulary.retry')}
                </button>
              </div>
            ) : null}
            {loadingMore ? (
              <p aria-live="polite" className="vocabulary-footer-status" role="status">
                {t('recorded.vocabulary.loadingMore')}
              </p>
            ) : nextCursor ? (
              <button className="vocabulary-load-more-button" onClick={loadMore} type="button">
                {t('recorded.vocabulary.loadMore')}
              </button>
            ) : null}
          </footer>
        </>
      )}

      <p className="sr-only" role="status">
        {deletedTerm ? t('recorded.vocabulary.deleteSucceeded', { term: deletedTerm }) : ''}
      </p>

      {confirmEntry ? (
        <div className="dialog-backdrop" onKeyDown={handleDialogKeyDown}>
          <div
            aria-labelledby="vocabulary-delete-dialog-title"
            aria-modal="true"
            className="dialog-card"
            role="dialog"
          >
            <h3 id="vocabulary-delete-dialog-title">
              {t('recorded.vocabulary.deleteDialogTitle')}
            </h3>
            <p className="dialog-text">
              {t('recorded.vocabulary.deleteDialogBody', { term: confirmEntry.term })}
            </p>
            {deleteError ? (
              <p className="dialog-text dialog-error" role="alert">
                {t(vocabularyManagementErrorKey(deleteError))}
              </p>
            ) : null}
            <div className="dialog-actions">
              <button
                className="dialog-cancel-button"
                disabled={deleting}
                onClick={closeDialog}
                ref={cancelButtonRef}
                type="button"
              >
                {t('recorded.vocabulary.deleteDialogCancel')}
              </button>
              <button
                className="dialog-danger-button"
                disabled={deleting}
                onClick={() => requestDelete(confirmEntry)}
                type="button"
              >
                {deleting
                  ? t('recorded.vocabulary.deleting')
                  : t('recorded.vocabulary.deleteDialogConfirm')}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  )
}
