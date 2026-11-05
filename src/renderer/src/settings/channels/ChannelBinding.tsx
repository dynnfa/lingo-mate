import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type {
  CommunicationApi,
  CommunicationErrorCode,
  CommunicationSnapshot
} from '../../../../shared/communication'

export type BindingCodeResult = Awaited<ReturnType<CommunicationApi['createChallenge']>>

export function ChannelBinding({
  connection,
  initialResult,
  reload
}: {
  connection: CommunicationSnapshot['connections'][number]
  initialResult?: BindingCodeResult
  reload(): Promise<void>
}): React.JSX.Element {
  const { t, i18n } = useTranslation('communication')
  // The host stores only a digest. Keep the plaintext code in this mounted view.
  const [localResult, setLocalResult] = useState<BindingCodeResult | null>()
  const [error, setError] = useState<CommunicationErrorCode | 'COPY_FAILED'>()
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState(false)
  const [now, setNow] = useState(Date.now)
  const status = useRef<HTMLParagraphElement>(null)
  // Polling may show a newly created card before its automatic code arrives.
  const current = localResult === undefined ? initialResult : localResult
  const code = current?.status === 'ok' ? current : undefined
  const displayError = error ?? (current?.status === 'error' ? current.error.code : undefined)
  const challenge = connection.bindingChallenge
  const expiresAt = challenge?.expiresAt ?? code?.expiresAt
  const trackingExpiry = expiresAt !== undefined && expiresAt > now
  useEffect(() => {
    if (!trackingExpiry) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [trackingExpiry])

  const active = challenge && challenge.expiresAt > now ? challenge : undefined
  const visibleCode =
    code && active?.challengeId === code.challengeId && code.expiresAt > now ? code : undefined
  const expired = !!expiresAt && expiresAt <= now

  const generate = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    setError(undefined)
    setLocalResult(null)
    setCopied(false)
    try {
      const result = await window.api.communication.createChallenge({
        connectionId: connection.id,
        capabilities: ['chat', 'sentence']
      })
      setLocalResult(result)
      setNow(Date.now())
      await reload()
    } catch {
      setError('COMMUNICATION_FAILED')
    } finally {
      setBusy(false)
    }
  }
  const copy = async (): Promise<void> => {
    if (!visibleCode || visibleCode.expiresAt <= Date.now()) return
    setError(undefined)
    try {
      await navigator.clipboard.writeText(`/bind ${visibleCode.code}`)
      setCopied(true)
    } catch {
      setError('COPY_FAILED')
    }
  }
  const confirm = async (): Promise<void> => {
    if (busy || !active?.externalActorId) return
    setBusy(true)
    setError(undefined)
    try {
      const result = await window.api.communication.confirmBinding({
        challengeId: active.challengeId
      })
      if (result.status === 'ok') {
        setLocalResult(null)
        setCopied(false)
      } else setError(result.error.code)
      await reload()
      if (result.status === 'ok') status.current?.focus()
    } catch {
      setError('COMMUNICATION_FAILED')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="channel-binding">
      <p ref={status} tabIndex={-1} role="status" className="channel-binding-status">
        {connection.bindingCount
          ? t('boundAccounts', { count: connection.bindingCount })
          : t('accountUnbound')}
      </p>
      <label className="channel-binding-code">
        {t('bindingCode')}
        <input
          readOnly
          value={visibleCode?.code ?? ''}
          placeholder={t('bindingCodeEmpty')}
          autoComplete="off"
          spellCheck={false}
        />
      </label>
      <p className="channel-binding-hint">{t('bindingInstructions')}</p>
      <p className="channel-binding-hint">{t('bindingCodePrivacy')}</p>
      {active && (
        <p className="channel-binding-hint">
          {t('bindingExpiresAt', {
            time: new Intl.DateTimeFormat(i18n.resolvedLanguage, { timeStyle: 'medium' }).format(
              active.expiresAt
            )
          })}
        </p>
      )}
      {expired && (
        <p role="status" className="channel-binding-hint">
          {t('bindingCodeExpired')}
        </p>
      )}
      <div className="channel-binding-actions">
        <button
          type="button"
          disabled={busy || connection.deleting}
          onClick={() => void generate()}
        >
          {t(code || challenge ? 'regenerateBindingCode' : 'generateBindingCode')}
        </button>
        {visibleCode && (
          <button type="button" disabled={busy || connection.deleting} onClick={() => void copy()}>
            {t('copyBindingCommand')}
          </button>
        )}
        {copied && visibleCode && <span role="status">{t('bindingCommandCopied')}</span>}
      </div>
      {active?.externalActorId && (
        <div className="channel-binding-candidate">
          <p>
            {t('bindingCandidate', {
              name: active.displayName || t('unnamedAccount'),
              userId: active.externalActorId
            })}
          </p>
          <button
            type="button"
            disabled={busy || connection.deleting}
            onClick={() => void confirm()}
          >
            {t('confirmAccountBinding')}
          </button>
        </div>
      )}
      {displayError && (
        <p role="alert" className="settings-error">
          {displayError === 'COPY_FAILED' ? t('bindingCopyFailed') : t(`errors.${displayError}`)}
        </p>
      )}
    </div>
  )
}
