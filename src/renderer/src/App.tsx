import { useEffect, useRef, useState, useSyncExternalStore, type SyntheticEvent } from 'react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { ConversationController } from './conversation/conversation-controller'
import { isGenerating } from './conversation/conversation-state'
import { translateConversationStatus } from './conversation/status-messages'
import { formatDateTime } from './i18n/formatters'
import { normalizeI18nLocale } from './i18n'
import { LanguageSettings } from './preferences/LanguageSettings'
import type { ConversationSummary } from '../../shared/conversation'

type AppTFunction = TFunction<['common', 'conversation', 'errors']>

// 翻译完整模板并显式传入当前界面 locale 格式化的时间，不拼接词语。
function formatConversationLabel(
  t: AppTFunction,
  locale: string,
  conversation: ConversationSummary
): string {
  const dateTime = formatDateTime(normalizeI18nLocale(locale), conversation.updatedAt)
  return t('conversation:listItemLabel', { dateTime })
}

interface AppProps {
  // 启动时偏好 IPC 拒绝/超时的提示开关，由 main.tsx 的启动流程传入。
  initialPreferenceError?: boolean
}

function App({ initialPreferenceError = false }: AppProps): React.JSX.Element {
  const { t, i18n } = useTranslation(['common', 'conversation', 'errors'])
  // 惰性初始化一次控制器；渲染只读取投影状态，不直接 map 协议事件。
  // 语言切换只触发重渲染，控制器与订阅不在此时重建。
  const [controller] = useState(() => new ConversationController(window.api.conversation))
  const state = useSyncExternalStore(controller.subscribe, controller.getState)
  const [draft, setDraft] = useState('')
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [preferenceNoticeVisible, setPreferenceNoticeVisible] = useState(initialPreferenceError)
  const settingsButtonRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    const detach = controller.attach()
    void controller.initialize()
    return detach
  }, [controller])

  const generating = isGenerating(state)
  const composerLocked = state.phase !== 'ready' || generating || state.commandPending

  const sendMessage = (formEvent: SyntheticEvent): void => {
    formEvent.preventDefault()
    if (composerLocked || !draft.trim()) return
    setDraft('')
    void controller.send(draft)
  }

  const closeSettings = (): void => {
    setSettingsOpen(false)
    settingsButtonRef.current?.focus()
  }

  return (
    <main className="chat-shell" data-phase={state.phase}>
      {preferenceNoticeVisible ? (
        <div className="preference-notice" role="alert">
          <p>{t('common:preferences.startupError')}</p>
          <button onClick={() => setPreferenceNoticeVisible(false)} type="button">
            {t('common:preferences.dismiss')}
          </button>
        </div>
      ) : null}
      <aside className="session-sidebar" aria-label={t('common:sidebar.label')}>
        <nav className="sidebar-menu" aria-label={t('common:sidebar.menuLabel')}>
          <button className="sidebar-menu-item" type="button">
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M6 4h12v17l-6-4-6 4V4Z" />
            </svg>
            {t('common:sidebar.menuRecorded')}
          </button>
          <button className="sidebar-menu-item" type="button">
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="m8 4 12 8-12 8V4Z" />
            </svg>
            {t('common:sidebar.menuPractice')}
          </button>
        </nav>
        <div className="session-heading">
          <h2>{t('common:sidebar.sessionsHeading')}</h2>
          <button
            className="new-session"
            disabled={state.phase !== 'ready' || state.commandPending}
            onClick={() => void controller.startNewConversation()}
            type="button"
          >
            <span aria-hidden="true">＋</span> {t('common:sidebar.newSession')}
          </button>
        </div>
        <nav className="session-list" aria-label={t('common:sidebar.listLabel')}>
          {state.conversations.map((conversation) => (
            <button
              className="session-item"
              aria-pressed={conversation.sessionId === state.sessionId}
              data-session-id={conversation.sessionId}
              disabled={state.phase !== 'ready' || state.commandPending}
              key={conversation.sessionId}
              onClick={() => void controller.switchSession(conversation.sessionId)}
              type="button"
            >
              <span className="session-details">
                <span className="session-title">
                  {formatConversationLabel(t, i18n.resolvedLanguage ?? 'zh-CN', conversation)}
                </span>
              </span>
            </button>
          ))}
          {state.conversations.length === 0 ? (
            <p className="session-placeholder">
              {state.phase === 'loading'
                ? t('common:sidebar.loadingSessions')
                : t('common:sidebar.noSessions')}
            </p>
          ) : null}
        </nav>
        <div
          className="sidebar-toolbar"
          role="toolbar"
          aria-label={t('common:sidebar.toolbarLabel')}
        >
          <button
            aria-expanded={settingsOpen}
            aria-haspopup="dialog"
            aria-label={t('common:settings.title')}
            className="settings-button"
            onClick={() => setSettingsOpen(true)}
            ref={settingsButtonRef}
            title={t('common:settings.title')}
            type="button"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="m9 3-.6 2.4-2 .9-2.3-.7-2 3.4 1.7 1.7v2.6L2.1 15l2 3.4 2.3-.7 2 .9L9 21h4l.6-2.4 2-.9 2.3.7 2-3.4-1.7-1.7v-2.6L19.9 9l-2-3.4-2.3.7-2-.9L13 3Z" />
              <circle cx="11" cy="12" r="3" />
            </svg>
          </button>
        </div>
      </aside>

      <div className="conversation-panel">
        <header className="chat-header">
          <div>
            <p className="eyebrow">LINGO MATE</p>
            <h1>{t('common:app.title')}</h1>
          </div>
          <p aria-live="polite" className="status">
            {translateConversationStatus(t, state.status)}
          </p>
        </header>

        <section aria-label={t('common:messages.regionLabel')} className="messages">
          {state.messages.length === 0 ? (
            <div className="empty-state">
              <div aria-hidden="true" className="empty-mark">
                Aa
              </div>
              <h2>{t('common:messages.emptyTitle')}</h2>
              <p>{t('common:messages.emptyBody')}</p>
            </div>
          ) : (
            state.messages.map((message) => (
              <article
                className={`message ${message.role}`}
                data-message-id={message.messageId}
                key={message.messageId}
              >
                <span>
                  {message.role === 'user' ? t('common:messages.userRole') : 'Lingo Mate'}
                </span>
                <p>{message.content || '…'}</p>
                {message.role === 'user' && message.retryable && !composerLocked ? (
                  <button
                    className="secondary retry"
                    onClick={() => void controller.retry(message.messageId)}
                    type="button"
                  >
                    {t('common:messages.retry')}
                  </button>
                ) : null}
              </article>
            ))
          )}
        </section>

        <form className="composer" onSubmit={sendMessage}>
          <label htmlFor="message">{t('common:composer.label')}</label>
          <div>
            <input
              disabled={composerLocked}
              id="message"
              maxLength={4000}
              onChange={(event) => setDraft(event.target.value)}
              placeholder={t('common:composer.placeholder')}
              value={draft}
            />
            {generating ? (
              <button className="secondary" onClick={() => void controller.cancel()} type="button">
                {t('common:composer.cancel')}
              </button>
            ) : (
              <button disabled={!draft.trim() || composerLocked} type="submit">
                {t('common:composer.send')}
              </button>
            )}
          </div>
        </form>
      </div>

      {settingsOpen ? <LanguageSettings onClose={closeSettings} /> : null}
    </main>
  )
}

export default App
