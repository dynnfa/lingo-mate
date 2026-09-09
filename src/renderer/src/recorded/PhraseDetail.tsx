import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { useTranslation } from 'react-i18next'
import type {
  DeletePhraseResult,
  ListPhraseResult,
  PhraseEntry,
  PhraseManagementErrorCode
} from '../../../shared/phrase'
import { phraseManagementErrorKey } from './phrase-messages'

type PhraseLoadState = 'loading' | 'ready' | 'error'

// 已记录页 Phrase 详情：读取收藏短语以表格展示，最右侧操作列支持
// 按短语主键单条删除。请求与删除状态集中在本组件，不经由对话控制器。
export function PhraseDetail(): React.JSX.Element {
  const { t } = useTranslation(['common', 'errors'])

  const [loadState, setLoadState] = useState<PhraseLoadState>('loading')
  const [entries, setEntries] = useState<PhraseEntry[]>([])
  const [nextCursor, setNextCursor] = useState<string | undefined>(undefined)
  const [loadError, setLoadError] = useState<PhraseManagementErrorCode | undefined>(undefined)
  const [loadingMore, setLoadingMore] = useState(false)
  const [moreError, setMoreError] = useState<PhraseManagementErrorCode | undefined>(undefined)
  const [confirmEntry, setConfirmEntry] = useState<PhraseEntry | undefined>(undefined)
  const [deleting, setDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState<PhraseManagementErrorCode | undefined>(undefined)
  const [deletedTerm, setDeletedTerm] = useState<string | undefined>(undefined)

  const mountedRef = useRef(true)
  const entriesRef = useRef<PhraseEntry[]>([])
  const nextCursorRef = useRef<string | undefined>(undefined)
  const initialSeqRef = useRef(0)
  const moreSeqRef = useRef(0)
  // 本地已删除的短语主键：迟到的列表结果不得让短语重新出现。
  const deletedPhrasesRef = useRef<Set<string>>(new Set())
  const rowActionRefs = useRef(new Map<string, HTMLButtonElement>())
  const headingRef = useRef<HTMLHeadingElement>(null)
  const pendingFocusRef = useRef<{ rowPhrase?: string } | undefined>(undefined)
  const dialogReturnButtonRef = useRef<HTMLButtonElement | null>(null)
  const cancelButtonRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  const applyEntries = useCallback((next: PhraseEntry[]): void => {
    entriesRef.current = next
    setEntries(next)
  }, [])

  const loadList = useCallback((): void => {
    // 新的首次读取同时使在途的加载更多结果过期。
    const seq = ++initialSeqRef.current
    moreSeqRef.current += 1
    window.api.phrase
      .list({})
      .then((result: ListPhraseResult) => {
        if (!mountedRef.current || initialSeqRef.current !== seq) return
        if (result.status === 'error') {
          setLoadError(result.error.code)
          setLoadState('error')
          return
        }
        applyEntries(result.entries.filter((entry) => !deletedPhrasesRef.current.has(entry.phrase)))
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
    window.api.phrase
      .list({ cursor })
      .then((result: ListPhraseResult) => {
        if (!mountedRef.current || moreSeqRef.current !== seq) return
        setLoadingMore(false)
        if (result.status === 'error') {
          setMoreError(result.error.code)
          return
        }
        // 追加时同时跳过本地已删除的主键与当前已展示的重复行。
        const current = entriesRef.current
        const seen = new Set(current.map((entry) => entry.phrase))
        const fresh = result.entries.filter(
          (entry) => !deletedPhrasesRef.current.has(entry.phrase) && !seen.has(entry.phrase)
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

  const openDeleteDialog = useCallback((entry: PhraseEntry, button: HTMLButtonElement): void => {
    dialogReturnButtonRef.current = button
    setDeleteError(undefined)
    setConfirmEntry(entry)
  }, [])

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
    (entry: PhraseEntry): void => {
      if (deleting) return
      setDeleting(true)
      setDeleteError(undefined)
      window.api.phrase
        .delete({ phrase: entry.phrase })
        .then((result: DeletePhraseResult) => {
          if (!mountedRef.current) return
          if (result.status === 'error') {
            setDeleteError(result.error.code)
            setDeleting(false)
            return
          }
          // deleted 为 false 表示目标已不存在，同样移除过期行，保证幂等。
          const current = entriesRef.current
          const index = current.findIndex((item) => item.phrase === entry.phrase)
          const neighbor = current[index + 1] ?? current[index - 1]
          pendingFocusRef.current = neighbor ? { rowPhrase: neighbor.phrase } : {}
          deletedPhrasesRef.current.add(entry.phrase)
          applyEntries(current.filter((item) => item.phrase !== entry.phrase))
          setConfirmEntry(undefined)
          setDeleting(false)
          setDeletedTerm(entry.phrase)
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
    if (target.rowPhrase) rowActionRefs.current.get(target.rowPhrase)?.focus()
    else headingRef.current?.focus()
  }, [entries])

  const handleDialogKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== 'Escape' || deleting) return
    // Escape 只关闭对话框，不冒泡触发已记录页退出。
    event.preventDefault()
    event.stopPropagation()
    closeDialog()
  }

  const setRowActionRef = useCallback((phrase: string, button: HTMLButtonElement | null): void => {
    if (button) rowActionRefs.current.set(phrase, button)
    else rowActionRefs.current.delete(phrase)
  }, [])

  return (
    <section aria-labelledby="phrase-detail-title" className="phrase-detail">
      <header className="phrase-detail-header">
        <h2 id="phrase-detail-title" ref={headingRef} tabIndex={-1}>
          {t('recorded.phrase.detailTitle')}
        </h2>
      </header>

      {loadState === 'loading' ? (
        <div aria-busy="true" className="phrase-state" role="status">
          {t('recorded.phrase.loading')}
        </div>
      ) : loadState === 'error' ? (
        <div className="phrase-state" role="alert">
          <p className="phrase-state-title">{t('recorded.phrase.loadErrorTitle')}</p>
          <p>{t(phraseManagementErrorKey(loadError ?? 'UNKNOWN_ERROR'))}</p>
          <button onClick={reload} type="button">
            {t('recorded.phrase.retry')}
          </button>
        </div>
      ) : entries.length === 0 && !nextCursor ? (
        <div className="phrase-state">
          <p className="phrase-state-title">{t('recorded.phrase.emptyTitle')}</p>
          <p>{t('recorded.phrase.emptyBody')}</p>
        </div>
      ) : (
        <>
          <div className="phrase-table-scroll">
            <table className="phrase-table">
              <caption className="sr-only">{t('recorded.phrase.tableCaption')}</caption>
              <thead>
                <tr>
                  <th scope="col">{t('recorded.phrase.columnPhrase')}</th>
                  <th scope="col">{t('recorded.phrase.columnExplantation')}</th>
                  <th scope="col">{t('recorded.phrase.columnExample')}</th>
                  <th className="phrase-actions-column" scope="col">
                    {t('recorded.phrase.columnActions')}
                  </th>
                </tr>
              </thead>
              <tbody>
                {entries.map((entry) => (
                  <tr key={entry.phrase}>
                    <td className="phrase-cell-phrase">{entry.phrase}</td>
                    <td className="phrase-cell-prewrap">{entry.explantation}</td>
                    <td className="phrase-cell-prewrap">{entry.example}</td>
                    <td className="phrase-actions-column phrase-actions-cell">
                      <button
                        aria-label={t('recorded.phrase.deleteButtonLabel', {
                          phrase: entry.phrase
                        })}
                        className="phrase-delete-button"
                        onClick={(event) => openDeleteDialog(entry, event.currentTarget)}
                        ref={(button) => setRowActionRef(entry.phrase, button)}
                        type="button"
                      >
                        {t('recorded.phrase.deleteButton')}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <footer className="phrase-footer">
            {moreError ? (
              <div className="phrase-more-error" role="alert">
                <p className="phrase-state-title">{t('recorded.phrase.loadMoreFailed')}</p>
                <p>{t(phraseManagementErrorKey(moreError))}</p>
                <button disabled={loadingMore} onClick={loadMore} type="button">
                  {t('recorded.phrase.retry')}
                </button>
              </div>
            ) : null}
            {loadingMore ? (
              <p aria-live="polite" className="phrase-footer-status" role="status">
                {t('recorded.phrase.loadingMore')}
              </p>
            ) : nextCursor ? (
              <button className="phrase-load-more-button" onClick={loadMore} type="button">
                {t('recorded.phrase.loadMore')}
              </button>
            ) : null}
          </footer>
        </>
      )}

      <p className="sr-only" role="status">
        {deletedTerm ? t('recorded.phrase.deleteSucceeded', { phrase: deletedTerm }) : ''}
      </p>

      {confirmEntry ? (
        <div className="dialog-backdrop" onKeyDown={handleDialogKeyDown}>
          <div
            aria-labelledby="phrase-delete-dialog-title"
            aria-modal="true"
            className="dialog-card"
            role="dialog"
          >
            <h3 id="phrase-delete-dialog-title">{t('recorded.phrase.deleteDialogTitle')}</h3>
            <p className="dialog-text">
              {t('recorded.phrase.deleteDialogBody', { phrase: confirmEntry.phrase })}
            </p>
            {deleteError ? (
              <p className="dialog-text dialog-error" role="alert">
                {t(phraseManagementErrorKey(deleteError))}
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
                {t('recorded.phrase.deleteDialogCancel')}
              </button>
              <button
                className="dialog-danger-button"
                disabled={deleting}
                onClick={() => requestDelete(confirmEntry)}
                type="button"
              >
                {deleting
                  ? t('recorded.phrase.deleting')
                  : t('recorded.phrase.deleteDialogConfirm')}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  )
}
