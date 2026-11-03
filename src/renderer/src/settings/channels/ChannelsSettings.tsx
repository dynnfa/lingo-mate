import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { CommunicationSnapshot } from '../../../../shared/communication'
export function ChannelsSettings({ active }: { active: boolean }): React.JSX.Element {
  const { t, i18n } = useTranslation('communication')
  const [snapshot, setSnapshot] = useState<CommunicationSnapshot>()
  const [error, setError] = useState(false)
  const [busy, setBusy] = useState(false)
  const [challenge, setChallenge] = useState<{ code: string; expiresAt: number }>()
  const [allowSentence, setAllowSentence] = useState(false)
  const [retryId, setRetryId] = useState<string>()
  const mounted = useRef(true)
  const focusAfterAction = useRef(false)
  const refreshButton = useRef<HTMLButtonElement>(null)
  const reload = useCallback(async (): Promise<void> => {
    try {
      const result = await window.api.communication.snapshot()
      if (!mounted.current) return
      if (result.status === 'ok') {
        setSnapshot(result.snapshot)
        setError(false)
      } else setError(true)
    } catch {
      if (mounted.current) setError(true)
    }
  }, [])
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  useEffect(() => {
    if (!active) return
    const initial = setTimeout(() => {
      void reload()
    }, 0)
    const timer = setInterval(() => {
      void reload()
    }, 3000)
    return () => {
      clearTimeout(initial)
      clearInterval(timer)
    }
  }, [active, reload])
  useEffect(() => {
    if (!busy && focusAfterAction.current) {
      focusAfterAction.current = false
      refreshButton.current?.focus()
    }
  }, [busy])
  const perform = async (operation: () => Promise<{ status: 'ok' | 'error' }>): Promise<void> => {
    setBusy(true)
    try {
      const result = await operation()
      if (!mounted.current) return
      if (result.status === 'error') setError(true)
      else {
        await reload()
        focusAfterAction.current = true
      }
    } catch {
      if (mounted.current) setError(true)
    } finally {
      if (mounted.current) setBusy(false)
    }
  }
  return (
    <div className="channels-settings">
      <button ref={refreshButton} type="button" disabled={busy} onClick={() => void reload()}>
        {t('refresh')}
      </button>
      {error && <p role="alert">{t('error')}</p>}
      {snapshot?.connections.length === 0 && <p>{t('empty')}</p>}
      {challenge && (
        <p role="status">
          {t('code', {
            code: challenge.code,
            expiresAt: new Date(challenge.expiresAt).toLocaleString(i18n.resolvedLanguage)
          })}
        </p>
      )}
      {Boolean(snapshot?.connections.length) && (
        <label>
          <input
            type="checkbox"
            checked={allowSentence}
            onChange={(e) => setAllowSentence(e.target.checked)}
          />
          {t('grantSentence')}
        </label>
      )}
      {snapshot?.connections.map((c) => (
        <section key={c.id} aria-label={c.adapterId}>
          <h3>{c.adapterId}</h3>
          <p>{t('state', { state: t(`states.${c.state}`) })}</p>
          <button
            type="button"
            disabled={busy}
            onClick={() =>
              void perform(() => window.api.communication.start({ connectionId: c.id }))
            }
          >
            {t('start')}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() =>
              void perform(() => window.api.communication.stop({ connectionId: c.id }))
            }
          >
            {t('stop')}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() =>
              void perform(async () => {
                const result = await window.api.communication.createChallenge({
                  connectionId: c.id,
                  capabilities: allowSentence ? ['chat', 'sentence'] : ['chat']
                })
                if (result.status === 'ok' && mounted.current) setChallenge(result)
                return result
              })
            }
          >
            {t('bind')}
          </button>
        </section>
      ))}
      {snapshot?.challenges.map((c) => (
        <div key={c.id}>
          <p>{t('account', { actor: c.actor })}</p>
          <button
            type="button"
            disabled={busy}
            onClick={() =>
              void perform(() => window.api.communication.confirmBinding({ challengeId: c.id }))
            }
          >
            {t('confirm')}
          </button>
        </div>
      ))}
      {snapshot?.bindings.map((b) => (
        <div key={b.id}>
          <p>{t('account', { actor: b.externalActorId })}</p>
          <button
            type="button"
            disabled={busy}
            onClick={() =>
              void perform(() => window.api.communication.revokeBinding({ bindingId: b.id }))
            }
          >
            {t('revoke')}
          </button>
        </div>
      ))}
      {snapshot?.receipts?.map((r) => (
        <p key={r.id}>
          {t('receipt', { state: t(`executionStates.${r.state}`), code: r.code ?? '' })}
        </p>
      ))}
      {snapshot?.requests.map((r) => (
        <div key={r.requestId}>
          <span>{t('request', { state: t(`executionStates.${r.state}`) })}</span>
          {['queued', 'running', 'dispatching'].includes(r.state) && (
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                void perform(() =>
                  window.api.communication.cancelRequest({
                    bindingId: r.bindingId,
                    requestId: r.requestId
                  })
                )
              }
            >
              {t('cancel')}
            </button>
          )}
        </div>
      ))}
      {snapshot?.deliveries.map((d) => (
        <div key={d.id}>
          <p>{t('delivery', { state: t(`deliveryStates.${d.state}`) })}</p>
          {['failed', 'uncertain'].includes(d.state) && (
            <>
              {d.state === 'uncertain' && (
                <label>
                  <input
                    type="checkbox"
                    checked={retryId === d.id}
                    onChange={(e) => setRetryId(e.target.checked ? d.id : undefined)}
                  />
                  {t('uncertain')}
                </label>
              )}
              <button
                type="button"
                disabled={busy || (d.state === 'uncertain' && retryId !== d.id)}
                onClick={() =>
                  void perform(() =>
                    window.api.communication.resolveDelivery({
                      deliveryId: d.id,
                      action: 'retry',
                      acknowledgeDuplicate: retryId === d.id
                    })
                  )
                }
              >
                {t('retry')}
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() =>
                  void perform(() =>
                    window.api.communication.resolveDelivery({
                      deliveryId: d.id,
                      action: 'suppress'
                    })
                  )
                }
              >
                {t('suppress')}
              </button>
            </>
          )}
        </div>
      ))}
    </div>
  )
}
