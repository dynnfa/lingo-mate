import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ConfirmDialog } from '../../components/ConfirmDialog'
import { LoadMoreBar } from '../../components/LoadMoreBar'
import { StateBlock } from '../../components/StateBlock'
import { useCursorList } from '../../hooks/use-cursor-list'
import type { PhraseEntry, PhraseManagementErrorCode } from '../../../../shared/phrase'
import { phraseManagementErrorKey, toPhraseManagementError } from './phrase-messages'

// 已记录页 Phrase 详情：读取收藏短语以表格展示，最右侧操作列支持
// 按短语主键单条删除。列表状态机由 useCursorList 持有，删除状态在本组件。
export function PhraseDetail(): React.JSX.Element {
  const { t } = useTranslation(['common', 'errors'])

  const loadPage = useCallback(
    async (
      cursor: string | null
    ): Promise<{ entries: PhraseEntry[]; nextCursor: string | null }> => {
      const result = await window.api.phrase.list(cursor === null ? {} : { cursor })
      if (result.status === 'error') throw result.error.code
      // 短语 IPC 的 nextCursor 为可选字段，耗尽时缺省；归一化为 null。
      return { entries: result.entries, nextCursor: result.nextCursor ?? null }
    },
    []
  )

  const list = useCursorList<PhraseEntry, string>({
    keyOf: (entry) => entry.phrase,
    load: loadPage
  })

  const [confirmEntry, setConfirmEntry] = useState<PhraseEntry | undefined>(undefined)
  const [deleting, setDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState<PhraseManagementErrorCode | undefined>(undefined)
  const [deletedTerm, setDeletedTerm] = useState<string | undefined>(undefined)

  const rowActionRefs = useRef(new Map<string, HTMLButtonElement>())
  const headingRef = useRef<HTMLHeadingElement>(null)
  const pendingFocusRef = useRef<{ rowPhrase?: string } | undefined>(undefined)
  const dialogReturnButtonRef = useRef<HTMLButtonElement | null>(null)

  const openDeleteDialog = useCallback((entry: PhraseEntry, button: HTMLButtonElement): void => {
    dialogReturnButtonRef.current = button
    setDeleteError(undefined)
    setConfirmEntry(entry)
  }, [])

  // 对话框打开后的初始聚焦与关闭后的焦点归还由 ConfirmDialog 负责；
  // 成功删除后移至相邻行或标题。
  const closeDialog = useCallback((): void => {
    setConfirmEntry(undefined)
    setDeleteError(undefined)
  }, [])

  const requestDelete = useCallback(
    (entry: PhraseEntry): void => {
      if (deleting) return
      setDeleting(true)
      setDeleteError(undefined)
      window.api.phrase
        .delete({ phrase: entry.phrase })
        .then((result) => {
          if (result.status === 'error') {
            setDeleteError(result.error.code)
            setDeleting(false)
            return
          }
          // deleted 为 false 表示目标已不存在，同样移除过期行，保证幂等。
          const current = list.getEntries()
          const index = current.findIndex((item) => item.phrase === entry.phrase)
          const neighbor = current[index + 1] ?? current[index - 1]
          pendingFocusRef.current = neighbor ? { rowPhrase: neighbor.phrase } : {}
          list.removeEntry(entry.phrase)
          setConfirmEntry(undefined)
          setDeleting(false)
          setDeletedTerm(entry.phrase)
        })
        .catch(() => {
          setDeleteError('UNKNOWN_ERROR')
          setDeleting(false)
        })
    },
    [deleting, list]
  )

  // 行移除渲染完成后，把焦点交还给相邻行的删除按钮或详情标题。
  useEffect(() => {
    const target = pendingFocusRef.current
    if (!target) return
    pendingFocusRef.current = undefined
    if (target.rowPhrase) rowActionRefs.current.get(target.rowPhrase)?.focus()
    else headingRef.current?.focus()
  }, [list.entries])

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

      {list.phase === 'loading' ? (
        <StateBlock
          className="phrase-state"
          message={t('recorded.phrase.loading')}
          variant="loading"
        />
      ) : list.phase === 'error' ? (
        <StateBlock
          className="phrase-state"
          message={t(phraseManagementErrorKey(toPhraseManagementError(list.loadError)))}
          onRetry={list.reload}
          retryLabel={t('recorded.phrase.retry')}
          title={t('recorded.phrase.loadErrorTitle')}
          variant="error"
        />
      ) : list.entries.length === 0 && list.nextCursor === null ? (
        <StateBlock
          className="phrase-state"
          message={t('recorded.phrase.emptyBody')}
          title={t('recorded.phrase.emptyTitle')}
          variant="empty"
        />
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
                {list.entries.map((entry) => (
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
          <LoadMoreBar
            error={
              list.moreError !== null
                ? {
                    title: t('recorded.phrase.loadMoreFailed'),
                    message: t(phraseManagementErrorKey(toPhraseManagementError(list.moreError)))
                  }
                : null
            }
            hasMore={list.nextCursor !== null}
            label={t('recorded.phrase.loadMore')}
            loadingLabel={t('recorded.phrase.loadingMore')}
            loadingMore={list.loadingMore}
            onLoadMore={list.loadMore}
            retryLabel={t('recorded.phrase.retry')}
          />
        </>
      )}

      <p className="sr-only" role="status">
        {deletedTerm ? t('recorded.phrase.deleteSucceeded', { phrase: deletedTerm }) : ''}
      </p>

      <ConfirmDialog
        busy={deleting}
        cancelLabel={t('recorded.phrase.deleteDialogCancel')}
        confirmLabel={
          deleting ? t('recorded.phrase.deleting') : t('recorded.phrase.deleteDialogConfirm')
        }
        description={
          confirmEntry
            ? t('recorded.phrase.deleteDialogBody', { phrase: confirmEntry.phrase })
            : undefined
        }
        error={deleteError ? t(phraseManagementErrorKey(deleteError)) : null}
        onCancel={closeDialog}
        onConfirm={() => confirmEntry && requestDelete(confirmEntry)}
        open={confirmEntry !== undefined}
        returnFocusRef={dialogReturnButtonRef}
        title={t('recorded.phrase.deleteDialogTitle')}
        tone="danger"
      />
    </section>
  )
}
