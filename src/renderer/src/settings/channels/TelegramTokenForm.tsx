import { useEffect, useId, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  telegramTokenSchema,
  type CommunicationApi,
  type communicationErrorSchema
} from '../../../../shared/communication'
import type { z } from 'zod'
type Result = Awaited<ReturnType<CommunicationApi['setCredential']>>
export function TelegramTokenForm({
  replacing,
  onSubmit,
  onClose
}: {
  replacing: boolean
  onSubmit(token: string): Promise<Result>
  onClose(): void
}): React.JSX.Element {
  const { t } = useTranslation('communication')
  const [token, setToken] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<z.infer<typeof communicationErrorSchema>['code']>()
  const input = useRef<HTMLInputElement>(null)
  const mounted = useRef(true)
  const id = useId()
  useEffect(() => {
    mounted.current = true
    input.current?.focus()
    return () => {
      mounted.current = false
    }
  }, [])
  useEffect(() => {
    if (!busy && error) input.current?.focus()
  }, [busy, error])
  const submit = async (): Promise<void> => {
    if (busy) return
    if (!telegramTokenSchema.safeParse(token).success) {
      setToken('')
      setError('INVALID_INPUT')
      input.current?.focus()
      return
    }
    const submitted = token
    setToken('')
    setBusy(true)
    setError(undefined)
    try {
      const result = await onSubmit(submitted)
      if (!mounted.current) return
      if (result.status === 'ok') onClose()
      else setError(result.error.code)
    } catch {
      if (mounted.current) setError('COMMUNICATION_FAILED')
    } finally {
      if (mounted.current) {
        setBusy(false)
      }
    }
  }
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault()
        void submit()
      }}
    >
      <label htmlFor={id}>{t('token')}</label>
      <input
        id={id}
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
      {error && (
        <p id={`${id}-error`} role="alert">
          {t(`errors.${error}`)}
        </p>
      )}
      <button type="submit" disabled={busy}>
        {t(replacing ? 'saveToken' : 'saveTelegram')}
      </button>
      <button type="button" disabled={busy} onClick={onClose}>
        {t('cancelForm')}
      </button>
    </form>
  )
}
