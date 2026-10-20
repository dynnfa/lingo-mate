import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ConfirmDialog } from '../../components/ConfirmDialog'
import { StateBlock } from '../../components/StateBlock'
import { channelsErrorKey, connectionErrorCodeKey, connectionStateKey } from './channels-messages'
import type { ChannelsSettingsState } from './useChannelsSettings'

// 设置页“聊天平台”区块：连接配置（Token 一次性提交、不回读）、连接状态、
// 绑定码生成、待确认绑定核对与解绑。状态本体由 SettingsPage 持有，
// 区块随菜单切换卸载时草稿不丢失。
export function ChannelsSettings({
  state
}: {
  state: ChannelsSettingsState
}): React.JSX.Element | null {
  const { t } = useTranslation(['common', 'errors'])
  const { loadState, status, tokenDraft, bindingCode, pendingAction, actionError } = state
  const [unbindConfirmOpen, setUnbindConfirmOpen] = useState(false)
  const [editingToken, setEditingToken] = useState(false)
  const unbindButtonRef = useRef<HTMLButtonElement | null>(null)

  if (loadState === 'loading') {
    return (
      <StateBlock
        className="chat-channels-loading"
        message={t('common:settings.chatChannels.loading')}
        variant="loading"
      />
    )
  }
  if (loadState === 'error' || status === undefined) {
    return (
      <StateBlock
        className="chat-channels-load-error"
        message={t('errors:chatChannels.readFailed')}
        onRetry={state.refresh}
        retryLabel={t('common:settings.chatChannels.retryLoad')}
        variant="error"
      />
    )
  }

  const busy = pendingAction !== null
  const connection = status.connection
  const binding = status.binding
  const pendingRequest = status.pendingBindingRequest

  return (
    <div className="chat-channels-settings">
      <p className="chat-channels-description">{t('common:settings.chatChannels.description')}</p>

      {connection === null ? (
        <section
          className="chat-channels-setup"
          aria-label={t('common:settings.chatChannels.setupTitle')}
        >
          <h3>{t('common:settings.chatChannels.setupTitle')}</h3>
          <label>
            <span>{t('common:settings.chatChannels.tokenLabel')}</span>
            <input
              autoComplete="off"
              onChange={(event) => state.setTokenDraft(event.target.value)}
              placeholder={t('common:settings.chatChannels.tokenPlaceholder')}
              type="password"
              value={tokenDraft}
            />
          </label>
          <button
            disabled={busy || tokenDraft.trim().length === 0}
            onClick={state.configure}
            type="button"
          >
            {pendingAction === 'configure'
              ? t('common:settings.chatChannels.configuring')
              : t('common:settings.chatChannels.configureButton')}
          </button>
        </section>
      ) : (
        <section
          className="chat-channels-connection"
          aria-label={t('common:settings.chatChannels.connectionTitle')}
        >
          <h3>{t('common:settings.chatChannels.connectionTitle')}</h3>
          <dl>
            <div>
              <dt>{t('common:settings.chatChannels.botLabel')}</dt>
              <dd>
                {connection.botUsername ? `@${connection.botUsername}` : `#${connection.botId}`}
              </dd>
            </div>
            <div>
              <dt>{t('common:settings.chatChannels.stateLabel')}</dt>
              <dd data-state={connection.state}>
                {t(connectionStateKey(connection.state))}
                {connection.state === 'error' && connection.errorCode
                  ? `：${t(connectionErrorCodeKey(connection.errorCode))}`
                  : ''}
              </dd>
            </div>
          </dl>
          <button disabled={busy} onClick={() => setEditingToken((value) => !value)} type="button">
            {t('common:settings.chatChannels.updateTokenButton')}
          </button>
          {editingToken && (
            <div className="chat-channels-token-update">
              <label>
                <span>{t('common:settings.chatChannels.tokenLabel')}</span>
                <input
                  autoComplete="off"
                  onChange={(event) => state.setTokenDraft(event.target.value)}
                  placeholder={t('common:settings.chatChannels.tokenPlaceholder')}
                  type="password"
                  value={tokenDraft}
                />
              </label>
              <button
                disabled={busy || tokenDraft.trim().length === 0}
                onClick={state.configure}
                type="button"
              >
                {t('common:settings.chatChannels.configureButton')}
              </button>
            </div>
          )}
          {connection.state === 'connected' ? (
            <button disabled={busy} onClick={() => void state.disconnect()} type="button">
              {t('common:settings.chatChannels.disconnectButton')}
            </button>
          ) : (
            <button
              disabled={busy || connection.state === 'connecting'}
              onClick={state.connect}
              type="button"
            >
              {t('common:settings.chatChannels.connectButton')}
            </button>
          )}
          {connection.errorCode === 'WEBHOOK_CONFLICT' && (
            <p className="chat-channels-hint">{t('common:settings.chatChannels.webhookHint')}</p>
          )}
          {connection.state === 'disconnected' && (
            <p className="chat-channels-hint">{t('common:settings.chatChannels.offlineHint')}</p>
          )}
        </section>
      )}

      {connection !== null && (
        <section
          className="chat-channels-binding"
          aria-label={t('common:settings.chatChannels.bindingTitle')}
        >
          <h3>{t('common:settings.chatChannels.bindingTitle')}</h3>
          {binding !== null ? (
            <>
              <p>
                {t('common:settings.chatChannels.boundAccount', {
                  name: binding.displayName ?? binding.senderId
                })}
              </p>
              <button
                disabled={busy}
                onClick={() => setUnbindConfirmOpen(true)}
                ref={unbindButtonRef}
                type="button"
              >
                {t('common:settings.chatChannels.unbindButton')}
              </button>
            </>
          ) : pendingRequest !== null ? (
            <>
              <p>
                {t('common:settings.chatChannels.pendingRequest', {
                  name: pendingRequest.displayName ?? pendingRequest.senderId
                })}
              </p>
              <div className="chat-channels-binding-actions">
                <button disabled={busy} onClick={state.confirmBinding} type="button">
                  {t('common:settings.chatChannels.confirmBindingButton')}
                </button>
                <button disabled={busy} onClick={state.rejectBinding} type="button">
                  {t('common:settings.chatChannels.rejectBindingButton')}
                </button>
              </div>
            </>
          ) : (
            <>
              {bindingCode !== null ? (
                <div className="chat-channels-binding-code">
                  <p aria-live="polite">
                    {t('common:settings.chatChannels.bindingCode', {
                      code: bindingCode.code,
                      minutes: bindingCode.minutesValid
                    })}
                  </p>
                  <p className="chat-channels-hint">
                    {t('common:settings.chatChannels.bindingCodeHint', {
                      code: bindingCode.code
                    })}
                  </p>
                </div>
              ) : (
                <button disabled={busy} onClick={state.issueBindingCode} type="button">
                  {t('common:settings.chatChannels.issueCodeButton')}
                </button>
              )}
            </>
          )}
        </section>
      )}

      {actionError !== null && (
        <p className="chat-channels-action-error" role="alert">
          {t(channelsErrorKey(actionError))}
        </p>
      )}

      <ConfirmDialog
        cancelLabel={t('common:settings.chatChannels.unbindCancel')}
        confirmLabel={t('common:settings.chatChannels.unbindConfirm')}
        description={t('common:settings.chatChannels.unbindConfirmBody')}
        onCancel={() => setUnbindConfirmOpen(false)}
        onConfirm={() => {
          setUnbindConfirmOpen(false)
          state.unbind()
        }}
        open={unbindConfirmOpen}
        returnFocusRef={unbindButtonRef}
        title={t('common:settings.chatChannels.unbindConfirmTitle')}
        tone="danger"
      />
    </div>
  )
}
