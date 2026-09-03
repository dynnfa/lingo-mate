import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import type { ConversationEvent, ConversationSummary } from '../../shared/conversation'

interface DisplayMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
}

type StartupPhase = 'loading' | 'ready' | 'failed'

const GENERIC_LOAD_ERROR = '无法加载会话，请稍后重试。'
const GENERIC_LIST_ERROR = '无法刷新会话列表，请稍后重试。'

function formatConversationLabel(conversation: ConversationSummary): string {
  const updatedAt = new Date(conversation.updatedAt)
  return `对话 · ${updatedAt.toLocaleDateString()} ${updatedAt.toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit'
  })}`
}

function App(): React.JSX.Element {
  const [phase, setPhase] = useState<StartupPhase>('loading')
  const [conversations, setConversations] = useState<ConversationSummary[]>([])
  const [activeSessionId, setActiveSessionId] = useState<string>()
  const activeSessionIdRef = useRef<string | undefined>(undefined)
  const conversationTransitionRef = useRef(0)
  const [messages, setMessages] = useState<DisplayMessage[]>([])
  const [draft, setDraft] = useState('')
  const [activeRequestId, setActiveRequestId] = useState<string>()
  const activeRequestIdRef = useRef<string | undefined>(undefined)
  const [status, setStatus] = useState('正在恢复会话…')

  const refreshConversations = useCallback(async (): Promise<void> => {
    try {
      const listed = await window.api.conversation.list()
      if (listed.status === 'error') {
        setStatus(listed.error.message)
        return
      }

      setConversations(listed.conversations)
    } catch {
      setStatus(GENERIC_LIST_ERROR)
    }
  }, [])

  const openConversation = useCallback(
    async (sessionId: string, transitionId: number): Promise<boolean> => {
      try {
        const loaded = await window.api.conversation.load({ sessionId })
        if (transitionId !== conversationTransitionRef.current) return false

        if (loaded.status === 'error') {
          setPhase('failed')
          setStatus(loaded.error.message)
          return false
        }

        activeSessionIdRef.current = sessionId
        setActiveSessionId(sessionId)
        setMessages(loaded.messages.map(({ id, role, content }) => ({ id, role, content })))
        setPhase('ready')
        setStatus('准备就绪')
        return true
      } catch {
        if (transitionId === conversationTransitionRef.current) {
          setPhase('failed')
          setStatus(GENERIC_LOAD_ERROR)
        }
        return false
      }
    },
    []
  )

  // 启动恢复策略：list → 打开最近会话；空库时 create → load。
  useEffect(() => {
    let cancelled = false
    const transitionId = ++conversationTransitionRef.current

    const recover = async (): Promise<void> => {
      try {
        const listed = await window.api.conversation.list()
        if (cancelled || transitionId !== conversationTransitionRef.current) return

        if (listed.status === 'error') {
          setPhase('failed')
          setStatus(listed.error.message)
          return
        }

        setConversations(listed.conversations)
        const latest = listed.conversations[0]
        if (latest) {
          await openConversation(latest.sessionId, transitionId)
          return
        }

        const created = await window.api.conversation.create()
        if (cancelled || transitionId !== conversationTransitionRef.current) return

        if (created.status === 'error') {
          setPhase('failed')
          setStatus(created.error.message)
          return
        }

        setConversations([created.conversation])
        await openConversation(created.conversation.sessionId, transitionId)
      } catch {
        if (!cancelled && transitionId === conversationTransitionRef.current) {
          setPhase('failed')
          setStatus(GENERIC_LOAD_ERROR)
        }
      }
    }

    void recover()
    return () => {
      cancelled = true
      if (transitionId === conversationTransitionRef.current) {
        conversationTransitionRef.current += 1
      }
    }
  }, [openConversation])

  const handleConversationEvent = useCallback(
    (event: ConversationEvent): void => {
      // 只接受与当前会话一致的事件，避免切换后旧事件写入新视图。
      if (event.sessionId !== activeSessionIdRef.current) return
      if (event.requestId !== activeRequestIdRef.current) return

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

      activeRequestIdRef.current = undefined
      setActiveRequestId(undefined)
      // 终态时移除 started 阶段添加、且未产出任何内容的回复占位，避免永久显示 "…"
      setMessages((current) =>
        current.filter((message) => message.id !== event.requestId || message.content !== '')
      )

      if (event.type === 'completed') {
        setStatus('回复完成')
        void refreshConversations()
      }
      if (event.type === 'cancelled') setStatus('已取消')
      if (event.type === 'failed') setStatus(event.error.message)
    },
    [refreshConversations]
  )

  useEffect(
    () => window.api.conversation.onEvent(handleConversationEvent),
    [handleConversationEvent]
  )

  const stopActiveRequest = async (): Promise<void> => {
    const requestId = activeRequestIdRef.current
    if (!requestId) return
    activeRequestIdRef.current = undefined
    setActiveRequestId(undefined)
    try {
      await window.api.conversation.cancel({ requestId })
    } catch {
      // 请求已在本地失效；后续事件仍会被 requestId 过滤。
    }
  }

  const switchConversation = async (sessionId: string): Promise<void> => {
    if (sessionId === activeSessionIdRef.current) return
    const transitionId = ++conversationTransitionRef.current
    activeSessionIdRef.current = undefined
    setPhase('loading')
    setStatus('正在切换会话…')
    await stopActiveRequest()
    if (transitionId !== conversationTransitionRef.current) return
    await openConversation(sessionId, transitionId)
  }

  const startNewConversation = async (): Promise<void> => {
    const transitionId = ++conversationTransitionRef.current
    activeSessionIdRef.current = undefined
    setPhase('loading')
    setStatus('正在创建会话…')
    await stopActiveRequest()
    if (transitionId !== conversationTransitionRef.current) return

    try {
      const created = await window.api.conversation.create()
      if (transitionId !== conversationTransitionRef.current) return
      if (created.status === 'error') {
        setPhase('failed')
        setStatus(created.error.message)
        return
      }

      setConversations((current) => [created.conversation, ...current])
      await openConversation(created.conversation.sessionId, transitionId)
    } catch {
      if (transitionId === conversationTransitionRef.current) {
        setPhase('failed')
        setStatus(GENERIC_LOAD_ERROR)
      }
    }
  }

  const sendMessage = async (formEvent: FormEvent): Promise<void> => {
    formEvent.preventDefault()
    const text = draft.trim()
    if (!text || activeRequestId || phase !== 'ready' || !activeSessionIdRef.current) return

    const requestId = crypto.randomUUID()
    setDraft('')
    activeRequestIdRef.current = requestId
    setActiveRequestId(requestId)
    setMessages((current) => [...current, { id: crypto.randomUUID(), role: 'user', content: text }])

    try {
      await window.api.conversation.send({
        requestId,
        sessionId: activeSessionIdRef.current,
        text
      })
    } catch {
      if (activeRequestIdRef.current !== requestId) return
      activeRequestIdRef.current = undefined
      setActiveRequestId(undefined)
      setStatus('无法发送消息，请稍后重试。')
    }
  }

  const cancelReply = async (): Promise<void> => {
    const requestId = activeRequestIdRef.current
    if (!requestId) return
    try {
      await window.api.conversation.cancel({ requestId })
    } catch {
      if (activeRequestIdRef.current === requestId) {
        setStatus('无法取消回复，请稍后重试。')
      }
    }
  }

  return (
    <main className="chat-shell" data-phase={phase}>
      <header>
        <p className="eyebrow">LINGO MATE</p>
        <h1>语言学习助手</h1>
        <p className="status" aria-live="polite">
          {status}
        </p>
        <div className="conversation-bar">
          <label htmlFor="conversation">会话</label>
          <select
            disabled={phase !== 'ready'}
            id="conversation"
            onChange={(event) => void switchConversation(event.target.value)}
            value={activeSessionId ?? ''}
          >
            {conversations.map((conversation) => (
              <option key={conversation.sessionId} value={conversation.sessionId}>
                {formatConversationLabel(conversation)}
              </option>
            ))}
          </select>
          <button
            className="secondary"
            disabled={phase !== 'ready'}
            onClick={() => void startNewConversation()}
            type="button"
          >
            新会话
          </button>
        </div>
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
            disabled={phase !== 'ready'}
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
            <button disabled={!draft.trim() || phase !== 'ready'} type="submit">
              发送
            </button>
          )}
        </div>
      </form>
    </main>
  )
}

export default App
