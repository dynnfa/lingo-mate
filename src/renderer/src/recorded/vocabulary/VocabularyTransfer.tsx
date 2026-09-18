import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ConfirmDialog } from '../../components/ConfirmDialog'
import {
  VOCABULARY_TRANSFER_LIMITS as LIMITS,
  type ImportPreview
} from '../../../../shared/vocabulary-transfer'
import { useVocabularyImport } from './useVocabularyImport'
import './VocabularyTransfer.css'

export function VocabularyTransfer({ onSaved }: { onSaved: () => void }): React.JSX.Element {
  const { t } = useTranslation('vocabulary')
  const { task, error, setError, accept, active } = useVocabularyImport(onSaved)
  const [open, setOpen] = useState(false)
  const [mode, setMode] = useState<'excel' | 'ai'>('excel')
  const [text, setText] = useState('')
  const [preview, setPreview] = useState<ImportPreview | null>(null)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState(false)
  const locked = useRef(false)
  const returnFocus = useRef<HTMLButtonElement>(null)
  const modesRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (open) {
      modesRef.current?.focus({ preventScroll: true })
      const card = modesRef.current?.closest('.confirm-card')
      if (card) card.scrollTop = 0
    }
  }, [open])
  const inputCount = text.split(/\r?\n/).filter((line) => line.trim()).length
  const run = async (operation: () => Promise<void>): Promise<void> => {
    if (locked.current) return
    locked.current = true
    setBusy(true)
    setError(null)
    setNotice(false)
    try {
      await operation()
    } catch {
      setError('UNKNOWN_ERROR')
    } finally {
      locked.current = false
      setBusy(false)
    }
  }
  const saveFile = (template: boolean): void => {
    void run(async () => {
      const result = await (template
        ? window.api.vocabulary.downloadTemplate()
        : window.api.vocabulary.exportExcel())
      if (result.status === 'error') setError(result.error.code)
      else if (result.status === 'ok') setNotice(true)
    })
  }
  const start = (retry = false): void => {
    void run(async () => {
      const result = await window.api.vocabulary.startImport({
        requestId: crypto.randomUUID(),
        text: retry ? 'retry' : text,
        ...(retry && task ? { retryRequestId: task.requestId } : {})
      })
      if (result.status === 'error') setError(result.error.code)
      else accept(result.task)
    })
  }
  const errorText = error ? t(`transfer.errors.${error}`) : null
  return (
    <div className="vocabulary-transfer">
      <button ref={returnFocus} type="button" onClick={() => setOpen(true)}>
        {t('transfer.import')}
      </button>
      <button type="button" disabled={busy} onClick={() => saveFile(false)}>
        {t('transfer.export')}
      </button>
      {!open && errorText && <p role="alert">{errorText}</p>}
      {!open && notice && <p role="status">{t('transfer.fileSaved')}</p>}
      {!open && active && (
        <span role="status">
          {t('transfer.progress', { processed: task?.processed, total: task?.total })}
        </span>
      )}
      <ConfirmDialog
        open={open}
        title={t('transfer.title')}
        confirmLabel={t('transfer.close')}
        onConfirm={() => setOpen(false)}
        onCancel={() => setOpen(false)}
        returnFocusRef={returnFocus}
        error={errorText}
      >
        <div className="vocabulary-import-panel">
          <div className="vocabulary-import-modes" ref={modesRef} tabIndex={-1}>
            <button
              type="button"
              aria-pressed={mode === 'excel'}
              disabled={active || busy}
              onClick={() => setMode('excel')}
            >
              {t('transfer.excel')}
            </button>
            <button
              type="button"
              aria-pressed={mode === 'ai'}
              disabled={active || busy}
              onClick={() => setMode('ai')}
            >
              {t('transfer.ai')}
            </button>
          </div>
          {mode === 'excel' ? (
            <>
              <p>
                {t('transfer.excelLimits', {
                  rows: LIMITS.excelRows,
                  mib: LIMITS.fileBytes / 1024 / 1024
                })}
              </p>
              <button type="button" disabled={busy || active} onClick={() => saveFile(true)}>
                {t('transfer.template')}
              </button>
              <button
                type="button"
                disabled={busy || active}
                onClick={() =>
                  void run(async () => {
                    const result = await window.api.vocabulary.previewExcel()
                    if (result.status === 'error') {
                      setError(result.error.code)
                      setPreview(null)
                    } else if (result.status === 'ok') setPreview(result.preview)
                  })
                }
              >
                {t('transfer.selectFile')}
              </button>
              {preview && (
                <>
                  <p role="status">{t('transfer.preview', preview)}</p>
                  <ul className="vocabulary-import-results">
                    {preview.issues.map((issue, index) => (
                      <li key={index}>
                        {t('transfer.issue', {
                          row: issue.row,
                          field: issue.field,
                          reason: t(`transfer.validation.${issue.code}`)
                        })}
                      </li>
                    ))}
                  </ul>
                  <button
                    type="button"
                    disabled={busy || active || preview.issues.length > 0 || preview.valid === 0}
                    onClick={() =>
                      void run(async () => {
                        const result = await window.api.vocabulary.confirmExcel({
                          importId: preview.importId
                        })
                        if (result.status === 'error') setError(result.error.code)
                        else {
                          accept(result.task)
                          setPreview(null)
                        }
                      })
                    }
                  >
                    {t('transfer.confirm')}
                  </button>
                </>
              )}
            </>
          ) : (
            <>
              <label htmlFor="vocabulary-import-text">{t('transfer.inputLabel')}</label>
              <textarea
                id="vocabulary-import-text"
                rows={4}
                maxLength={LIMITS.textLength}
                value={text}
                disabled={active || busy}
                placeholder={t('transfer.placeholder')}
                onChange={(event) => setText(event.target.value)}
              />
              <p>
                {t('transfer.aiLimits', { rows: LIMITS.aiRows, characters: LIMITS.textLength })}
              </p>
              <p>{t('transfer.inputCount', { count: inputCount })}</p>
              <button
                type="button"
                disabled={busy || active || !inputCount || inputCount > LIMITS.aiRows}
                onClick={() => start()}
              >
                {t('transfer.start')}
              </button>
            </>
          )}
          {notice && <p role="status">{t('transfer.fileSaved')}</p>}
          {task && (
            <section aria-label={t('transfer.results')}>
              <p role="status" aria-live="polite">
                {t(`transfer.phases.${task.phase}`)} ·{' '}
                {t('transfer.progress', { processed: task.processed, total: task.total })}
              </p>
              <p>{t('transfer.summary', task.counts)}</p>
              {task.phase === 'analyzing' && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      const result = await window.api.vocabulary.cancelImport({
                        requestId: task.requestId
                      })
                      if (result.status === 'error') setError(result.error.code)
                      else accept(result.task)
                    })
                  }
                >
                  {t('transfer.cancel')}
                </button>
              )}
              {!active &&
                task.phase !== 'cancelled' &&
                task.rows.some((row) => row.status === 'failed') &&
                task.kind === 'ai' && (
                  <button type="button" disabled={busy} onClick={() => start(true)}>
                    {t('transfer.retry')}
                  </button>
                )}
              <ul className="vocabulary-import-results">
                {task.rows.map((row) => (
                  <li key={row.row}>
                    {t('transfer.row', { row: row.row, term: row.term })} ·{' '}
                    {t(`transfer.rowStates.${row.status}`)}
                    {row.code ? ` · ${t(`transfer.errors.${row.code}`)}` : ''}
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
      </ConfirmDialog>
    </div>
  )
}
