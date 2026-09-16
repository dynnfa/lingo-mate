import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ConfirmDialog } from '../../components/ConfirmDialog'
import { LoadMoreBar } from '../../components/LoadMoreBar'
import { StateBlock } from '../../components/StateBlock'
import { useCursorList } from '../../hooks/useCursorList'
import type {
  VocabularyCursor,
  VocabularyEntry,
  VocabularyManagementErrorCode
} from '../../../../shared/vocabulary'
import { toVocabularyManagementError, vocabularyManagementErrorKey } from './vocabulary-messages'

// 已记录页 Vocabulary 详情：读取收藏词汇以表格展示，最右侧操作列支持
// 按 id 单条删除。列表状态机由 useCursorList 持有，删除状态在本组件。
export function VocabularyDetail(): React.JSX.Element {
  const { t } = useTranslation(['common', 'errors'])

  const loadPage = useCallback(
    async (
      cursor: VocabularyCursor | null
    ): Promise<{ entries: VocabularyEntry[]; nextCursor: VocabularyCursor | null }> => {
      const result = await window.api.vocabulary.list(cursor === null ? {} : { cursor })
      if (result.status === 'error') throw result.error.code
      // 词汇 IPC 的 nextCursor 为可选字段，耗尽时缺省；归一化为 null。
      return { entries: result.entries, nextCursor: result.nextCursor ?? null }
    },
    []
  )

  const list = useCursorList<VocabularyEntry, VocabularyCursor>({
    keyOf: (entry) => entry.id,
    load: loadPage
  })

  const [confirmEntry, setConfirmEntry] = useState<VocabularyEntry | undefined>(undefined)
  const [deleting, setDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState<VocabularyManagementErrorCode | undefined>(
    undefined
  )
  const [deletedTerm, setDeletedTerm] = useState<string | undefined>(undefined)

  const rowActionRefs = useRef(new Map<string, HTMLButtonElement>())
  const headingRef = useRef<HTMLHeadingElement>(null)
  const pendingFocusRef = useRef<{ rowId?: string } | undefined>(undefined)
  const dialogReturnButtonRef = useRef<HTMLButtonElement | null>(null)

  const openDeleteDialog = useCallback(
    (entry: VocabularyEntry, button: HTMLButtonElement): void => {
      dialogReturnButtonRef.current = button
      setDeleteError(undefined)
      setConfirmEntry(entry)
    },
    []
  )

  // 对话框打开后的初始聚焦与关闭后的焦点归还由 ConfirmDialog 负责；
  // 成功删除后移至相邻行或标题。
  const closeDialog = useCallback((): void => {
    setConfirmEntry(undefined)
    setDeleteError(undefined)
  }, [])

  const requestDelete = useCallback(
    (entry: VocabularyEntry): void => {
      if (deleting) return
      setDeleting(true)
      setDeleteError(undefined)
      window.api.vocabulary
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
          setDeletedTerm(entry.term)
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

      {list.phase === 'loading' ? (
        <StateBlock
          className="vocabulary-state"
          message={t('recorded.vocabulary.loading')}
          variant="loading"
        />
      ) : list.phase === 'error' ? (
        <StateBlock
          className="vocabulary-state"
          message={t(vocabularyManagementErrorKey(toVocabularyManagementError(list.loadError)))}
          onRetry={list.reload}
          retryLabel={t('recorded.vocabulary.retry')}
          title={t('recorded.vocabulary.loadErrorTitle')}
          variant="error"
        />
      ) : list.entries.length === 0 && list.nextCursor === null ? (
        <StateBlock
          className="vocabulary-state"
          message={t('recorded.vocabulary.emptyBody')}
          title={t('recorded.vocabulary.emptyTitle')}
          variant="empty"
        />
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
                  <th className="vocabulary-actions-column" scope="col">
                    {t('recorded.vocabulary.columnActions')}
                  </th>
                </tr>
              </thead>
              <tbody>
                {list.entries.map((entry) => (
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
          <LoadMoreBar
            error={
              list.moreError !== null
                ? {
                    title: t('recorded.vocabulary.loadMoreFailed'),
                    message: t(
                      vocabularyManagementErrorKey(toVocabularyManagementError(list.moreError))
                    )
                  }
                : null
            }
            hasMore={list.nextCursor !== null}
            label={t('recorded.vocabulary.loadMore')}
            loadingLabel={t('recorded.vocabulary.loadingMore')}
            loadingMore={list.loadingMore}
            onLoadMore={list.loadMore}
            retryLabel={t('recorded.vocabulary.retry')}
          />
        </>
      )}

      <p className="sr-only" role="status">
        {deletedTerm ? t('recorded.vocabulary.deleteSucceeded', { term: deletedTerm }) : ''}
      </p>

      <ConfirmDialog
        busy={deleting}
        cancelLabel={t('recorded.vocabulary.deleteDialogCancel')}
        confirmLabel={
          deleting
            ? t('recorded.vocabulary.deleting')
            : t('recorded.vocabulary.deleteDialogConfirm')
        }
        description={
          confirmEntry
            ? t('recorded.vocabulary.deleteDialogBody', { term: confirmEntry.term })
            : undefined
        }
        error={deleteError ? t(vocabularyManagementErrorKey(deleteError)) : null}
        onCancel={closeDialog}
        onConfirm={() => confirmEntry && requestDelete(confirmEntry)}
        open={confirmEntry !== undefined}
        returnFocusRef={dialogReturnButtonRef}
        title={t('recorded.vocabulary.deleteDialogTitle')}
        tone="danger"
      />
    </section>
  )
}
