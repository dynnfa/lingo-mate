import { useEffect, useId, useRef, useState, type RefObject } from 'react'
import { useTranslation } from 'react-i18next'
import {
  telegramTokenSchema,
  qqAppIdSchema,
  qqAppSecretSchema,
  type CommunicationApi,
  type CommunicationErrorCode,
  type CommunicationSnapshot
} from '../../../../shared/communication'
import { ConfirmDialog } from '../../components/ConfirmDialog'

export type ChannelCredentialDraft =
  { adapter: 'telegram'; token: string } | { adapter: 'qq'; appId?: string; appSecret: string }

type SaveResult = Awaited<ReturnType<CommunicationApi['setCredential']>>

export function ChannelTokenDialog({
  editingAdapter,
  installedAdapters,
  onSave,
  onClose,
  returnFocusRef
}: {
  editingAdapter?: string
  installedAdapters: CommunicationSnapshot['installedAdapters']
  onSave(draft: ChannelCredentialDraft): Promise<SaveResult>
  onClose(): void
  returnFocusRef: RefObject<HTMLElement | null>
}): React.JSX.Element {
  const { t } = useTranslation('communication')
  const [selectedAdapter, setAdapter] = useState('')
  const [appId, setAppId] = useState('')
  const editing = editingAdapter !== undefined
  const adapter = editingAdapter ?? selectedAdapter
  const qq = adapter === 'qq'
  const [token, setToken] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<CommunicationErrorCode>()
  const select = useRef<HTMLSelectElement>(null)
  const input = useRef<HTMLInputElement>(null)
  const id = useId()
  const showToken = qq || adapter === 'telegram'

  useEffect(() => {
    if (!busy && error) input.current?.focus()
  }, [busy, error])

  const submit = async (): Promise<void> => {
    if (busy || !showToken) return
    const parsed = (qq ? qqAppSecretSchema : telegramTokenSchema).safeParse(token)
    const appIdValid = !qq || editing || qqAppIdSchema.safeParse(appId).success
    setToken('')
    if (!parsed.success || !appIdValid) {
      setError('INVALID_INPUT')
      input.current?.focus()
      return
    }
    setBusy(true)
    setError(undefined)
    try {
      const result = await onSave(
        qq
          ? { adapter: 'qq', appId: editing ? undefined : appId, appSecret: parsed.data }
          : { adapter: 'telegram', token: parsed.data }
      )
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
      title={t(editing ? (qq ? 'editQqSecret' : 'editToken') : 'addChannel')}
      confirmLabel={t(editing ? (qq ? 'saveQqSecret' : 'saveToken') : 'saveTelegram')}
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
                setAppId('')
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
        {qq && !editing && (
          <>
            <p className="confirm-text">{t('qqSetup')}</p>
            <label>
              {t('qqAppId')}
              <input
                value={appId}
                onChange={(event) => setAppId(event.target.value)}
                inputMode="numeric"
                autoComplete="off"
                maxLength={20}
                disabled={busy}
              />
            </label>
          </>
        )}
        {showToken && (
          <label>
            {t(qq ? 'qqAppSecret' : 'token')}
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
            {t(qq && error === 'INVALID_INPUT' ? 'qqInvalidInput' : `errors.${error}`)}
          </p>
        )}
      </form>
    </ConfirmDialog>
  )
}
