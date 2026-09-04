import { useState, type SyntheticEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { translateConversationStatus } from './status-messages'
import type { ConversationStatus, DisplayMessage } from './conversation-state'

interface ConversationPanelProps {
  messages: DisplayMessage[]
  status: ConversationStatus
  generating: boolean
  composerLocked: boolean
  onSend: (text: string) => void
  onCancel: () => void
  onRetry: (messageId: string) => void
}

// 右侧对话区：消息与状态全部来自 props，未发送草稿归本组件所有；
// 回调只表达交互意图，异步结果经 Controller 的状态投影反馈回来。
export function ConversationPanel({
  messages,
  status,
  generating,
  composerLocked,
  onSend,
  onCancel,
  onRetry
}: ConversationPanelProps): React.JSX.Element {
  const { t } = useTranslation(['common', 'conversation', 'errors'])
  const [draft, setDraft] = useState('')

  const sendMessage = (formEvent: SyntheticEvent): void => {
    formEvent.preventDefault()
    if (composerLocked || !draft.trim()) return
    setDraft('')
    // 传原始草稿，trim 由 Controller 完成。
    onSend(draft)
  }

  return (
    <div className="conversation-panel">
      <header className="chat-header">
        <div>
          <p className="eyebrow">LINGO MATE</p>
          <h1>{t('common:app.title')}</h1>
        </div>
        <p aria-live="polite" className="status">
          {translateConversationStatus(t, status)}
        </p>
      </header>

      <section aria-label={t('common:messages.regionLabel')} className="messages">
        {messages.length === 0 ? (
          <div className="empty-state">
            <div aria-hidden="true" className="empty-mark">
              Aa
            </div>
            <h2>{t('common:messages.emptyTitle')}</h2>
            <p>{t('common:messages.emptyBody')}</p>
          </div>
        ) : (
          messages.map((message) => (
            <article
              className={`message ${message.role}`}
              data-message-id={message.messageId}
              key={message.messageId}
            >
              <span>{message.role === 'user' ? t('common:messages.userRole') : 'Lingo Mate'}</span>
              <p>{message.content || '…'}</p>
              {message.role === 'user' && message.retryable && !composerLocked ? (
                <button
                  className="secondary retry"
                  onClick={() => onRetry(message.messageId)}
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
        <div>
          <input
            aria-label={t('common:composer.label')}
            disabled={composerLocked}
            id="message"
            maxLength={4000}
            onChange={(event) => setDraft(event.target.value)}
            placeholder={t('common:composer.placeholder')}
            value={draft}
          />
          {generating ? (
            <button className="secondary" onClick={onCancel} type="button">
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
  )
}
