import { useCallback, useEffect, useRef, useState, type SyntheticEvent } from 'react'
import { useTranslation } from 'react-i18next'
import type {
  VocabularyApi,
  VocabularyBatch,
  VocabularyCursor,
  VocabularyEntry,
  VocabularyErrorCode
} from '../../../shared/vocabulary'

interface VocabularyPanelProps {
  onExit: () => void
  api?: VocabularyApi
}
export function VocabularyPanel({
  onExit,
  api = window.api.vocabulary
}: VocabularyPanelProps): React.JSX.Element {
  const { t } = useTranslation('vocabulary')
  const [draft, setDraft] = useState('')
  const [batch, setBatch] = useState<VocabularyBatch>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<VocabularyErrorCode>()
  const [cancelNotice, setCancelNotice] = useState<'cancelled' | 'too_late'>()
  const [entries, setEntries] = useState<VocabularyEntry[]>([])
  const [cursor, setCursor] = useState<VocabularyCursor>()
  const [listError, setListError] = useState<VocabularyErrorCode>()
  const [loadingList, setLoadingList] = useState(true)
  const alive = useRef(false)
  const activeRequest = useRef<string | undefined>(undefined)
  const listVersion = useRef(0)
  const input = useRef<HTMLTextAreaElement>(null)
  const composing = useRef(false)
  const loadPage = useCallback(
    (nextCursor?: VocabularyCursor): Promise<void> => {
      const version = ++listVersion.current
      // Apply list state only from the external request's settlement, including
      // synchronous bridge failures. Versioning also discards stale pagination.
      return Promise.resolve()
        .then(() => api.list({ limit: 50, ...(nextCursor ? { cursor: nextCursor } : {}) }))
        .then((result) => {
          if (!alive.current || version !== listVersion.current) return
          if (result.status === 'error') {
            setListError(result.error.code)
            return
          }
          setListError(undefined)
          setEntries((previous) => (nextCursor ? [...previous, ...result.entries] : result.entries))
          setCursor(result.nextCursor)
        })
        .catch(() => {
          if (alive.current && version === listVersion.current) setListError('UNKNOWN_ERROR')
        })
        .finally(() => {
          if (alive.current && version === listVersion.current) setLoadingList(false)
        })
    },
    [api]
  )
  useEffect(() => {
    alive.current = true
    input.current?.focus()
    const versionRef = listVersion
    void loadPage()
    return () => {
      alive.current = false
      versionRef.current++
      const requestId = activeRequest.current
      activeRequest.current = undefined
      if (requestId) void api.cancelBatch({ requestId }).catch(() => {})
    }
  }, [api, loadPage])
  const refresh = (nextCursor?: VocabularyCursor): Promise<void> => {
    setLoadingList(true)
    setListError(undefined)
    return loadPage(nextCursor)
  }
  const submit = async (text: string): Promise<void> => {
    if (activeRequest.current || !text.trim()) return
    const requestId = crypto.randomUUID()
    activeRequest.current = requestId
    setBusy(true)
    setError(undefined)
    setCancelNotice(undefined)
    setBatch(undefined)
    try {
      const result = await api.addBatch({ requestId, text, wordLanguage: 'en' })
      if (!alive.current || activeRequest.current !== requestId) return
      if (result.status === 'error') setError(result.error.code)
      else if (result.batch.requestId !== requestId) setError('UNKNOWN_ERROR')
      else {
        setBatch(result.batch)
        if (result.batch.counts.saved) void refresh()
      }
    } catch {
      if (alive.current && activeRequest.current === requestId) setError('UNKNOWN_ERROR')
    } finally {
      if (alive.current && activeRequest.current === requestId) {
        activeRequest.current = undefined
        setBusy(false)
      }
    }
  }
  const cancel = async (): Promise<void> => {
    const requestId = activeRequest.current
    if (!requestId) return
    try {
      const result = await api.cancelBatch({ requestId })
      if (!alive.current || activeRequest.current !== requestId) return
      if (result.status === 'error') setError(result.error.code)
      else setCancelNotice(result.outcome)
    } catch {
      if (alive.current && activeRequest.current === requestId) setError('UNKNOWN_ERROR')
    }
    // Only addBatch's final result determines whether anything was saved.
  }
  const retryText = batch?.items
    .filter((item) => item.status === 'failed')
    .map((item) => item.term)
    .join(', ')
  const onSubmit = (event: SyntheticEvent): void => {
    event.preventDefault()
    if (!composing.current) void submit(draft)
  }
  return (
    <section className="vocabulary-panel" aria-label={t('title')}>
      <header className="vocabulary-heading">
        <div>
          <h2>{t('title')}</h2>
          <p>{t('scope')}</p>
        </div>
        <button className="secondary" onClick={onExit} type="button">
          {t('exit')}
        </button>
      </header>
      <form onSubmit={onSubmit}>
        <label htmlFor="vocabulary-input">{t('inputLabel')}</label>
        <textarea
          id="vocabulary-input"
          ref={input}
          value={draft}
          disabled={busy}
          placeholder={t('placeholder')}
          onChange={(event) => setDraft(event.target.value)}
          onCompositionStart={() => {
            composing.current = true
          }}
          onCompositionEnd={() => {
            composing.current = false
          }}
          onKeyDown={(event) => {
            if (
              event.key === 'Enter' &&
              (event.ctrlKey || event.metaKey) &&
              !event.nativeEvent.isComposing &&
              !composing.current
            ) {
              event.preventDefault()
              void submit(draft)
            }
          }}
        />
        <p>{t('limits')}</p>
        <div className="vocabulary-buttons">
          <button disabled={busy || !draft.trim()} type="submit">
            {busy ? t('running') : t('submit')}
          </button>
          {busy ? (
            <button className="secondary" onClick={() => void cancel()} type="button">
              {t('cancel')}
            </button>
          ) : null}
          {retryText && !busy ? (
            <button
              className="secondary"
              type="button"
              onClick={() => {
                setDraft(retryText)
                void submit(retryText)
              }}
            >
              {t('retry')}
            </button>
          ) : null}
        </div>
      </form>
      {error ? <p role="alert">{t(`errors.${error}`)}</p> : null}
      {busy && cancelNotice ? <p role="status">{t(`cancelNotice.${cancelNotice}`)}</p> : null}
      {batch ? (
        <section aria-label={t('results')} aria-live="polite">
          <h3>{t(`outcome.${batch.outcome}`)}</h3>
          <p>{t('summary', { ...batch.counts, count: batch.counts.total })}</p>
          <ol>
            {batch.items.map((item) => {
              const source = item.status === 'duplicate' ? batch.items[item.sourceInputIndex] : item
              return (
                <li key={item.inputIndex}>
                  <strong>{item.term}</strong> — {t(`status.${item.status}`)}
                  {item.status === 'duplicate'
                    ? ` · ${t('duplicateOf', { index: item.sourceInputIndex + 1 })}`
                    : ''}
                  {source.status === 'failed' ? ` · ${t(`errors.${source.code}`)}` : ''}
                </li>
              )
            })}
          </ol>
        </section>
      ) : null}
      <section aria-label={t('savedList')}>
        <div className="vocabulary-heading">
          <h3>{t('savedList')}</h3>
          <button
            className="secondary"
            type="button"
            disabled={loadingList}
            onClick={() => void refresh()}
          >
            {t('refresh')}
          </button>
        </div>
        <p>{t('generatedNotice')}</p>
        {listError ? <p role="alert">{t(`errors.${listError}`)}</p> : null}
        {loadingList ? <p role="status">{t('loading')}</p> : null}
        {!entries.length && !loadingList && !listError ? <p>{t('empty')}</p> : null}
        {entries.map((entry) => (
          <article className="vocabulary-entry" key={entry.id}>
            <h4>{entry.term}</h4>
            <p>
              {t('explanationLanguage', { language: t(`languages.${entry.explanationLanguage}`) })}
            </p>
            <ol>
              {entry.analysis.senses.map((sense) => (
                <li key={sense.id} id={`vocabulary-${entry.id}-${sense.id}`}>
                  <span>{t(`partOfSpeech.${sense.partOfSpeech}`)}</span> · {sense.definition}
                  <ul>
                    {entry.analysis.pronunciations
                      .filter((pronunciation) => pronunciation.senseIds.includes(sense.id))
                      .map((pronunciation, index) => (
                        <li key={index}>
                          <span lang="en">{pronunciation.ipa}</span> ·{' '}
                          {t(`accents.${pronunciation.accent}`)} — {pronunciation.guidance}
                        </li>
                      ))}
                  </ul>
                </li>
              ))}
            </ol>
          </article>
        ))}
        {cursor ? (
          <button
            disabled={loadingList}
            className="secondary"
            type="button"
            onClick={() => void refresh(cursor)}
          >
            {t('more')}
          </button>
        ) : null}
      </section>
    </section>
  )
}
