import { useEffect, useState, useSyncExternalStore } from 'react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { ConversationController } from './conversation/conversation-controller'
import { isGenerating } from './conversation/conversation-state'
import { ConversationPanel } from './conversation/ConversationPanel'
import { formatDateTime } from './i18n/formatters'
import { normalizeI18nLocale } from './i18n'
import { useAppViewNavigation } from './hooks/useAppViewNavigation'
import { RecordedPage } from './recorded/RecordedPage'
import { SettingsPage } from './settings/SettingsPage'
import { PracticePage } from './practice/PracticePage'
import type { ConversationSummary } from '../../shared/conversation'

type AppTFunction = TFunction<['common', 'conversation', 'errors']>

// 翻译完整模板并显式传入当前界面 locale 格式化的时间，不拼接词语。
function formatConversationLabel(
  t: AppTFunction,
  locale: string,
  conversation: ConversationSummary
): string {
  if (conversation.title) return conversation.title
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
  const { activeView, openView, returnToConversation, entryButtonRefs } = useAppViewNavigation()
  // 先解构为局部标识符再绑定 ref；直接 ref={entryButtonRefs.x} 会被
  // react-hooks/refs 规则判定为渲染期访问 ref。
  const {
    settings: settingsButtonRef,
    recorded: recordedButtonRef,
    practice: practiceButtonRef
  } = entryButtonRefs
  const [preferenceNoticeVisible, setPreferenceNoticeVisible] = useState(initialPreferenceError)
  // 启动焦点请求会在会话加载完成、输入框解锁后执行。
  const [composerFocusRequest, setComposerFocusRequest] = useState(1)

  useEffect(() => {
    const detach = controller.attach()
    void controller.initialize()
    return detach
  }, [controller])

  const generating = isGenerating(state)
  const composerLocked = state.phase !== 'ready' || generating || state.commandPending

  const startNewConversation = async (): Promise<void> => {
    const previousSessionId = controller.getState().sessionId
    await controller.startNewConversation()
    const nextState = controller.getState()
    if (nextState.phase === 'ready' && nextState.sessionId !== previousSessionId) {
      setComposerFocusRequest((request) => request + 1)
    }
  }

  return (
    <>
      {/* 设置页/已记录页期间保持对话视图挂载并隐藏，未发送草稿与滚动状态不丢失 */}
      <main className="chat-shell" data-phase={state.phase} hidden={activeView !== 'conversation'}>
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
            <button
              className="sidebar-menu-item"
              onClick={() => openView('recorded')}
              ref={recordedButtonRef}
              type="button"
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M6 4h12v17l-6-4-6 4V4Z" />
              </svg>
              {t('common:sidebar.menuRecorded')}
            </button>
            <button
              className="sidebar-menu-item"
              onClick={() => openView('practice')}
              ref={practiceButtonRef}
              type="button"
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="m8 4 12 8-12 8V4Z" />
              </svg>
              {t('common:sidebar.menuPractice')}
            </button>
          </nav>
          <div className="session-heading">
            <h2>{t('common:sidebar.sessionsHeading')}</h2>
            <button
              aria-label={t('common:sidebar.newSession')}
              className="new-session"
              disabled={state.phase !== 'ready' || state.commandPending}
              onClick={() => void startNewConversation()}
              title={t('common:sidebar.newSession')}
              type="button"
            >
              <span aria-hidden="true">＋</span>
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
              aria-label={t('common:settings.title')}
              className="settings-button"
              onClick={() => openView('settings')}
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

        <ConversationPanel
          messages={state.messages}
          status={state.status}
          generating={generating || state.commandPending}
          composerLocked={composerLocked}
          composerFocusRequest={composerFocusRequest}
          onSend={(text) => controller.send(text)}
          onRunSkill={(input) => controller.runSkill(input)}
          onCancel={() => void controller.cancel()}
          onRetry={(messageId) => void controller.retry(messageId)}
        />
      </main>

      {activeView === 'settings' ? <SettingsPage onExit={returnToConversation} /> : null}
      {activeView === 'recorded' ? <RecordedPage onExit={returnToConversation} /> : null}
      {activeView === 'practice' ? <PracticePage onExit={returnToConversation} /> : null}
    </>
  )
}

export default App
