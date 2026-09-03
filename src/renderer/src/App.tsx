import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import type { ConversationEvent } from '../../shared/conversation'

interface DisplayMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
}

function App(): React.JSX.Element {
  const sessionId = useRef(crypto.randomUUID())
  const [messages, setMessages] = useState<DisplayMessage[]>([])
  const [draft, setDraft] = useState('')
  const [activeRequestId, setActiveRequestId] = useState<string>()
  const [status, setStatus] = useState('准备就绪')

  const handleConversationEvent = useCallback((event: ConversationEvent): void => {
    if (event.sessionId !== sessionId.current) return

    if (event.type === 'started') {
      setStatus('正在生成…')
      setMessages((current) => [
        ...current,
        { id: event.requestId, role: 'assistant', content: '' }
      ])
      return
    }

    if (event.type === 'chunk') {
      setMessages((current) =>
        current.map((message) =>
          message.id === event.requestId
            ? { ...message, content: message.content + event.delta }
            : message
        )
      )
      return
    }

    setActiveRequestId(undefined)
    // 终态时移除 started 阶段添加、且未产出任何内容的回复占位，避免永久显示 "…"
    setMessages((current) =>
      current.filter((message) => message.id !== event.requestId || message.content !== '')
    )

    if (event.type === 'completed') setStatus('回复完成')
    if (event.type === 'cancelled') setStatus('已取消')
    if (event.type === 'failed') setStatus(event.error.message)
  }, [])

  useEffect(
    () => window.api.conversation.onEvent(handleConversationEvent),
    [handleConversationEvent]
  )

  const sendMessage = async (formEvent: FormEvent): Promise<void> => {
    formEvent.preventDefault()
    const text = draft.trim()
    if (!text || activeRequestId) return

    const requestId = crypto.randomUUID()
    setDraft('')
    setActiveRequestId(requestId)
    setMessages((current) => [...current, { id: crypto.randomUUID(), role: 'user', content: text }])

    try {
      await window.api.conversation.send({ requestId, sessionId: sessionId.current, text })
    } catch {
      setActiveRequestId(undefined)
      setStatus('无法发送消息，请稍后重试。')
    }
  }

  const cancelReply = async (): Promise<void> => {
    if (!activeRequestId) return
    await window.api.conversation.cancel({ requestId: activeRequestId })
  }

  return (
    <main className="chat-shell">
      <header>
        <p className="eyebrow">LINGO MATE</p>
        <h1>语言学习助手</h1>
        <p className="status" aria-live="polite">
          {status}
        </p>
      </header>

      <section className="messages" aria-label="对话记录">
        {messages.length === 0 ? (
          <p className="empty-state">输入一句话，开始第一个本地对话切片。</p>
        ) : (
          messages.map((message) => (
            <article className={`message ${message.role}`} key={message.id}>
              <span>{message.role === 'user' ? '你' : 'Lingo Mate'}</span>
              <p>{message.content || '…'}</p>
            </article>
          ))
        )}
      </section>

      <form className="composer" onSubmit={sendMessage}>
        <label htmlFor="message">练习内容</label>
        <div>
          <input
            id="message"
            maxLength={4000}
            onChange={(event) => setDraft(event.target.value)}
            placeholder="例如：帮我用英语改写这句话"
            value={draft}
          />
          {activeRequestId ? (
            <button className="secondary" onClick={cancelReply} type="button">
              取消
            </button>
          ) : (
            <button disabled={!draft.trim()} type="submit">
              发送
            </button>
          )}
        </div>
      </form>
    </main>
  )
}

export default App
