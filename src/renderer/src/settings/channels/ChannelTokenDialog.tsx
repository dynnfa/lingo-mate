import { useEffect, useId, useRef, useState, type RefObject } from 'react'
import { useTranslation } from 'react-i18next'
import {
  telegramTokenSchema,
  type CommunicationApi,
  type CommunicationErrorCode,
  type CommunicationSnapshot
} from '../../../../shared/communication'
import { ConfirmDialog } from '../../components/ConfirmDialog'

type SaveResult = Awaited<ReturnType<CommunicationApi['setCredential']>>

export function ChannelTokenDialog({
  editing,
  installedAdapters,
  onSave,
  onClose,
  returnFocusRef
}: {
  editing: boolean
  installedAdapters: CommunicationSnapshot['installedAdapters']
  onSave(token: string): Promise<SaveResult>
  onClose(): void
  returnFocusRef: RefObject<HTMLElement | null>
}): React.JSX.Element {
  const { t } = useTranslation('communication')
  const [adapter, setAdapter] = useState('')
  const [token, setToken] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<CommunicationErrorCode>()
  const select = useRef<HTMLSelectElement>(null)
  const input = useRef<HTMLInputElement>(null)
  const id = useId()
  const showToken = editing || adapter === 'telegram'

  useEffect(() => {
    if (!busy && error) input.current?.focus()
  }, [busy, error])

  const submit = async (): Promise<void> => {
    if (busy || !showToken) return
    const parsed = telegramTokenSchema.safeParse(token)
    setToken('')
    if (!parsed.success) {
      setError('INVALID_INPUT')
      input.current?.focus()
      return
    }
    setBusy(true)
    setError(undefined)
    try {
      const result = await onSave(parsed.data)
      if (result.status === 'ok') onClose()
      else setError(result.error.code)
    } catch {
      setError('COMMUNICATION_FAILED')
    } finally {
      setBusy(false)
    }
  }

  return (
    <ConfirmDialog
      open
      title={t(editing ? 'editToken' : 'addChannel')}
      confirmLabel={t(editing ? 'saveToken' : 'saveTelegram')}
      cancelLabel={t('cancelForm')}
      formId={id}
      busy={busy}
      confirmDisabled={!showToken}
      initialFocusRef={editing ? input : select}
      returnFocusRef={returnFocusRef}
      onCancel={onClose}
    >
      <form
        id={id}
        className="channel-token-form"
        onSubmit={(event) => {
          event.preventDefault()
          void submit()
        }}
      >
        {!editing && (
          <label>
            {t('channelType')}
            <select
              ref={select}
              value={adapter}
              onChange={(event) => {
                setAdapter(event.target.value)
                setToken('')
                setError(undefined)
              }}
              disabled={busy}
            >
              <option value="">{t('chooseChannel')}</option>
              {installedAdapters.map((item) => (
                <option value={item} key={item}>
                  {t(`adapters.${item}`)}
                </option>
              ))}
            </select>
          </label>
        )}
        {!editing && installedAdapters.length === 0 && (
          <p className="confirm-text">{t('noChannelTypes')}</p>
        )}
        {showToken && (
          <label>
            {t('token')}
            <input
              ref={input}
              type="password"
              value={token}
              onChange={(event) => setToken(event.target.value)}
              autoComplete="off"
              spellCheck={false}
              maxLength={256}
              disabled={busy}
              aria-invalid={!!error}
              aria-describedby={error ? `${id}-error` : undefined}
            />
          </label>
        )}
        {error && (
          <p id={`${id}-error`} role="alert" className="settings-error">
            {t(`errors.${error}`)}
          </p>
        )}
      </form>
    </ConfirmDialog>
  )
}
