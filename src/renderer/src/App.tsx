import { useEffect, useState, useSyncExternalStore, type SyntheticEvent } from 'react'
import { ConversationController } from './conversation/conversation-controller'
import { isGenerating } from './conversation/conversation-state'

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

  const sendMessage = (formEvent: SyntheticEvent): void => {
    formEvent.preventDefault()
    if (composerLocked || !draft.trim()) return
    setDraft('')
    void controller.send(draft)
  }

  return (
    <main className="chat-shell" data-phase={state.phase}>
      <aside className="session-sidebar" aria-label="会话侧栏">
        <nav className="sidebar-menu" aria-label="学习菜单">
          <button className="sidebar-menu-item" type="button">
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M6 4h12v17l-6-4-6 4V4Z" />
            </svg>
            已记录
          </button>
          <button className="sidebar-menu-item" type="button">
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="m8 4 12 8-12 8V4Z" />
            </svg>
            开始练习
          </button>
        </nav>
        <div className="session-heading">
          <h2>会话</h2>
          <button
            className="new-session"
            disabled={state.phase !== 'ready' || state.commandPending}
            onClick={() => void controller.startNewConversation()}
            type="button"
          >
            <span aria-hidden="true">＋</span> 新会话
          </button>
        </div>
        <nav className="session-list" aria-label="会话列表">
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
                <span className="session-title">语言练习</span>
              </span>
            </button>
          ))}
          {state.conversations.length === 0 ? (
            <p className="session-placeholder">
              {state.phase === 'loading' ? '正在加载会话…' : '暂无会话'}
            </p>
          ) : null}
        </nav>
        <div className="sidebar-toolbar" role="toolbar" aria-label="侧栏工具栏">
          <button className="settings-button" type="button" aria-label="设置" title="设置">
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
            <h1>语言学习助手</h1>
          </div>
          <p className="status" aria-live="polite">
            {state.statusMessage}
          </p>
        </header>

        <section className="messages" aria-label="对话记录">
          {state.messages.length === 0 ? (
            <div className="empty-state">
              <div className="empty-mark" aria-hidden="true">
                Aa
              </div>
              <h2>从一句话开始</h2>
              <p>练习表达、修改句子，或聊聊你感兴趣的话题。</p>
            </div>
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
      </div>
    </main>
  )
}

export default App
