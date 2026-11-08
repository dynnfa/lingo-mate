import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type {
  CommunicationApi,
  CommunicationErrorCode,
  CommunicationSnapshot
} from '../../../../shared/communication'

import { ConfirmDialog } from '../../components/ConfirmDialog'

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
  const qq = connection.adapterId === 'qq'
  const canGenerate = !qq || connection.state === 'online'
  const [sentenceAllowed, setSentenceAllowed] = useState(true)
  const [revoke, setRevoke] = useState<NonNullable<typeof connection.bindings>[number]>()
  const revokeFocus = useRef<HTMLElement | null>(null)
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
    if (busy || !canGenerate) return
    setBusy(true)
    setError(undefined)
    setLocalResult(null)
    setCopied(false)
    try {
      const result = await window.api.communication.createChallenge({
        connectionId: connection.id,
        capabilities: !qq || sentenceAllowed ? ['chat', 'sentence'] : ['chat']
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

  const unbind = async (): Promise<void> => {
    if (!revoke || busy) return
    setBusy(true)
    setError(undefined)
    try {
      const result = await window.api.communication.revokeBinding({ bindingId: revoke.bindingId })
      if (result.status === 'ok') {
        revokeFocus.current = status.current
        await reload()
        setRevoke(undefined)
      } else setError(result.error.code)
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
      <p className="channel-binding-hint">
        {t(qq ? 'qqBindingInstructions' : 'bindingInstructions')}
      </p>
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
      {qq && (
        <label className="channel-binding-hint">
          <input
            type="checkbox"
            checked={sentenceAllowed}
            disabled={busy || connection.deleting}
            onChange={(event) => setSentenceAllowed(event.target.checked)}
          />
          {t('qqSentencePermission')}
        </label>
      )}
      <div className="channel-binding-actions">
        <button
          type="button"
          disabled={busy || connection.deleting || !canGenerate}
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
            {t(qq ? 'qqBindingCandidate' : 'bindingCandidate', {
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
      {connection.bindings?.map((binding) => (
        <div key={binding.bindingId} className="channel-binding-candidate">
          <p>{t('qqBoundAccount', { userId: binding.openId })}</p>
          <button
            type="button"
            disabled={busy || connection.deleting}
            aria-label={t('qqUnbindAccount', { userId: binding.openId })}
            onClick={(event) => {
              revokeFocus.current = event.currentTarget
              setError(undefined)
              setRevoke(binding)
            }}
          >
            {t('qqUnbind')}
          </button>
        </div>
      ))}
      {revoke && (
        <ConfirmDialog
          open
          title={t('qqUnbind')}
          tone="danger"
          description={t('qqUnbindPrompt', { userId: revoke.openId })}
          confirmLabel={t('qqUnbind')}
          cancelLabel={t('cancelForm')}
          busy={busy}
          error={error && error !== 'COPY_FAILED' ? t(`errors.${error}`) : undefined}
          onCancel={() => {
            setRevoke(undefined)
            setError(undefined)
          }}
          onConfirm={() => void unbind()}
          returnFocusRef={revokeFocus}
        />
      )}
      {displayError && !revoke && (
        <p role="alert" className="settings-error">
          {displayError === 'COPY_FAILED' ? t('bindingCopyFailed') : t(`errors.${displayError}`)}
        </p>
      )}
    </div>
  )
}
