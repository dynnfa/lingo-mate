import { useCallback, useEffect, useRef, useState } from 'react'
import { normalizeI18nLocale } from '../../i18n'
import { formatDateTime } from '../../i18n/formatters'
import { useTranslation } from 'react-i18next'
import { ConfirmDialog } from '../../components/ConfirmDialog'
import { LoadMoreBar } from '../../components/LoadMoreBar'
import { StateBlock } from '../../components/StateBlock'
import { useCursorList } from '../../hooks/useCursorList'
import type {
  SentenceCursor,
  SentenceEntry,
  SentenceManagementErrorCode
} from '../../../../shared/sentence'
import { sentenceManagementErrorKey, toSentenceManagementError } from './sentence-messages'

// 已记录页 Sentence 详情：读取收藏句子以表格展示，最右侧操作列支持
// 按句子 ID单条删除。列表状态机由 useCursorList 持有，删除状态在本组件。
export function SentenceDetail(): React.JSX.Element {
  const { t, i18n } = useTranslation(['common', 'errors'])

  const loadPage = useCallback(
    async (
      cursor: SentenceCursor | null
    ): Promise<{ entries: SentenceEntry[]; nextCursor: SentenceCursor | null }> => {
      const result = await window.api.sentence.list(cursor === null ? {} : { cursor })
      if (result.status === 'error') throw result.error.code
      // 句子 IPC 的 nextCursor 为可选字段，耗尽时缺省；归一化为 null。
      return { entries: result.entries, nextCursor: result.nextCursor ?? null }
    },
    []
  )

  const list = useCursorList<SentenceEntry, SentenceCursor>({
    keyOf: (entry) => entry.id,
    load: loadPage
  })

  const [confirmEntry, setConfirmEntry] = useState<SentenceEntry | undefined>(undefined)
  const [deleting, setDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState<SentenceManagementErrorCode | undefined>(undefined)
  const [deletedTerm, setDeletedTerm] = useState<string | undefined>(undefined)

  const rowActionRefs = useRef(new Map<string, HTMLButtonElement>())
  const headingRef = useRef<HTMLHeadingElement>(null)
  const pendingFocusRef = useRef<{ rowId?: string } | undefined>(undefined)
  const dialogReturnButtonRef = useRef<HTMLButtonElement | null>(null)

  const openDeleteDialog = useCallback((entry: SentenceEntry, button: HTMLButtonElement): void => {
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
    (entry: SentenceEntry): void => {
      if (deleting) return
      setDeleting(true)
      setDeleteError(undefined)
      window.api.sentence
        .delete({ id: entry.id })
        .then((result) => {
          if (result.status === 'error') {
            setDeleteError(result.error.code)
            setDeleting(false)
            return
          }
          // deleted 为 false 表示目标已不存在，同样移除过期行，保证幂等。
          const current = list.getEntries()
          const index = current.findIndex((item) => item.id === entry.id)
          const neighbor = current[index + 1] ?? current[index - 1]
          pendingFocusRef.current = neighbor ? { rowId: neighbor.id } : {}
          list.removeEntry(entry.id)
          setConfirmEntry(undefined)
          setDeleting(false)
          setDeletedTerm(entry.sourceText)
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
    if (target.rowId) rowActionRefs.current.get(target.rowId)?.focus()
    else headingRef.current?.focus()
  }, [list.entries])

  const setRowActionRef = useCallback((id: string, button: HTMLButtonElement | null): void => {
    if (button) rowActionRefs.current.set(id, button)
    else rowActionRefs.current.delete(id)
  }, [])

  return (
    <section aria-labelledby="sentence-detail-title" className="phrase-detail">
      <header className="phrase-detail-header">
        <h2 id="sentence-detail-title" ref={headingRef} tabIndex={-1}>
          {t('recorded.sentence.detailTitle')}
        </h2>
      </header>

      {list.phase === 'loading' ? (
        <StateBlock
          className="phrase-state"
          message={t('recorded.sentence.loading')}
          variant="loading"
        />
      ) : list.phase === 'error' ? (
        <StateBlock
          className="phrase-state"
          message={t(sentenceManagementErrorKey(toSentenceManagementError(list.loadError)))}
          onRetry={list.reload}
          retryLabel={t('recorded.sentence.retry')}
          title={t('recorded.sentence.loadErrorTitle')}
          variant="error"
        />
      ) : list.entries.length === 0 && list.nextCursor === null ? (
        <StateBlock
          className="phrase-state"
          message={t('recorded.sentence.emptyBody')}
          title={t('recorded.sentence.emptyTitle')}
          variant="empty"
        />
      ) : (
        <>
          <div className="phrase-table-scroll">
            <table className="phrase-table">
              <caption className="sr-only">{t('recorded.sentence.tableCaption')}</caption>
              <thead>
                <tr>
                  <th scope="col">{t('recorded.sentence.columnSource')}</th>
                  <th scope="col">{t('recorded.sentence.columnTranslation')}</th>
                  <th scope="col">{t('recorded.sentence.columnCreatedAt')}</th>
                  <th className="phrase-actions-column" scope="col">
                    {t('recorded.sentence.columnActions')}
                  </th>
                </tr>
              </thead>
              <tbody>
                {list.entries.map((entry) => (
                  <tr key={entry.id}>
                    <td className="phrase-cell-prewrap">{entry.sourceText}</td>
                    <td className="phrase-cell-prewrap">{entry.translation}</td>
                    <td className="phrase-cell-prewrap">
                      <time dateTime={entry.createdAt}>
                        {formatDateTime(normalizeI18nLocale(i18n.language), entry.createdAt)}
                      </time>
                    </td>
                    <td className="phrase-actions-column phrase-actions-cell">
                      <button
                        aria-label={t('recorded.sentence.deleteButtonLabel', {
                          sentence: entry.sourceText
                        })}
                        className="phrase-delete-button"
                        onClick={(event) => openDeleteDialog(entry, event.currentTarget)}
                        ref={(button) => setRowActionRef(entry.id, button)}
                        type="button"
                      >
                        {t('recorded.sentence.deleteButton')}
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
                    title: t('recorded.sentence.loadMoreFailed'),
                    message: t(
                      sentenceManagementErrorKey(toSentenceManagementError(list.moreError))
                    )
                  }
                : null
            }
            hasMore={list.nextCursor !== null}
            label={t('recorded.sentence.loadMore')}
            loadingLabel={t('recorded.sentence.loadingMore')}
            loadingMore={list.loadingMore}
            onLoadMore={list.loadMore}
            retryLabel={t('recorded.sentence.retry')}
          />
        </>
      )}

      <p className="sr-only" role="status">
        {deletedTerm ? t('recorded.sentence.deleteSucceeded', { sentence: deletedTerm }) : ''}
      </p>

      <ConfirmDialog
        busy={deleting}
        cancelLabel={t('recorded.sentence.deleteDialogCancel')}
        confirmLabel={
          deleting ? t('recorded.sentence.deleting') : t('recorded.sentence.deleteDialogConfirm')
        }
        description={
          confirmEntry
            ? t('recorded.sentence.deleteDialogBody', { sentence: confirmEntry.sourceText })
            : undefined
        }
        error={deleteError ? t(sentenceManagementErrorKey(deleteError)) : null}
        onCancel={closeDialog}
        onConfirm={() => confirmEntry && requestDelete(confirmEntry)}
        open={confirmEntry !== undefined}
        returnFocusRef={dialogReturnButtonRef}
        title={t('recorded.sentence.deleteDialogTitle')}
        tone="danger"
      />
    </section>
  )
}
