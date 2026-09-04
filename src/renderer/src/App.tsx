import { useEffect, useState, useSyncExternalStore, type FormEvent } from 'react'
import type { ConversationSummary } from '../../shared/conversation'
import { ConversationController } from './conversation/conversation-controller'
import { isGenerating } from './conversation/conversation-state'

function formatConversationLabel(conversation: ConversationSummary): string {
  const updatedAt = new Date(conversation.updatedAt)
  return `对话 · ${updatedAt.toLocaleDateString()} ${updatedAt.toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit'
  })}`
}

function App(): React.JSX.Element {
  // 惰性初始化一次控制器；渲染只读取投影状态，不直接 map 协议事件。
  const [controller] = useState(() => new ConversationController(window.api.conversation))
  const state = useSyncExternalStore(controller.subscribe, controller.getState)
  const [draft, setDraft] = useState('')

  useEffect(() => {
    const detach = controller.attach()
    void controller.initialize()
    return detach
  }, [controller])

  const generating = isGenerating(state)
  const composerLocked = state.phase !== 'ready' || generating || state.commandPending

  const sendMessage = (formEvent: FormEvent): void => {
    formEvent.preventDefault()
    if (composerLocked || !draft.trim()) return
    setDraft('')
    void controller.send(draft)
  }

  return (
    <main className="chat-shell" data-phase={state.phase}>
      <header>
        <p className="eyebrow">LINGO MATE</p>
        <h1>语言学习助手</h1>
        <p className="status" aria-live="polite">
          {state.statusMessage}
        </p>
        <div className="conversation-bar">
          <label htmlFor="conversation">会话</label>
          <select
            disabled={state.phase !== 'ready' || state.commandPending}
            id="conversation"
            onChange={(event) => void controller.switchSession(event.target.value)}
            value={state.sessionId ?? ''}
          >
            {state.conversations.map((conversation) => (
              <option key={conversation.sessionId} value={conversation.sessionId}>
                {formatConversationLabel(conversation)}
              </option>
            ))}
          </select>
          <button
            className="secondary"
            disabled={state.phase !== 'ready' || state.commandPending}
            onClick={() => void controller.startNewConversation()}
            type="button"
          >
            新会话
          </button>
        </div>
      </header>

      <section className="messages" aria-label="对话记录">
        {state.messages.length === 0 ? (
          <p className="empty-state">输入一句话，开始第一个本地对话切片。</p>
        ) : (
          state.messages.map((message) => (
            <article
              className={`message ${message.role}`}
              data-message-id={message.messageId}
              key={message.messageId}
            >
              <span>{message.role === 'user' ? '你' : 'Lingo Mate'}</span>
              <p>{message.content || '…'}</p>
              {message.role === 'user' && message.retryable && !composerLocked ? (
                <button
                  className="secondary retry"
                  onClick={() => void controller.retry(message.messageId)}
                  type="button"
                >
                  重试
                </button>
              ) : null}
            </article>
          ))
        )}
      </section>

      <form className="composer" onSubmit={sendMessage}>
        <label htmlFor="message">练习内容</label>
        <div>
          <input
            disabled={composerLocked}
            id="message"
            maxLength={4000}
            onChange={(event) => setDraft(event.target.value)}
            placeholder="例如：帮我用英语改写这句话"
            value={draft}
          />
          {generating ? (
            <button className="secondary" onClick={() => void controller.cancel()} type="button">
              取消
            </button>
          ) : (
            <button disabled={!draft.trim() || composerLocked} type="submit">
              发送
            </button>
          )}
        </div>
      </form>
    </main>
  )
}

export default App
