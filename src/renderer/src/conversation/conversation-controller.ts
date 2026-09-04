import type { ConversationApi } from '../../../shared/conversation'
import {
  initialConversationState,
  isGenerating,
  reduceConversation,
  type ConversationAction,
  type ConversationState
} from './conversation-state'

const GENERIC_LOAD_ERROR = '无法加载会话，请稍后重试。'
const GENERIC_LIST_ERROR = '无法刷新会话列表，请稍后重试。'
const GENERIC_SEND_ERROR = '无法发送消息，请稍后重试。'
const GENERIC_CANCEL_ERROR = '无法取消回复，请稍后重试。'
const GENERIC_RETRY_ERROR = '无法重试，请稍后重试。'

// Conversation Projection 的控制器：持有唯一的投影状态，
// 封装 window.api 调用、事件订阅、会话切换过渡和命令失败处理。
// React 视图只读取状态并提交 send/cancel/retry 意图。
export class ConversationController {
  private state: ConversationState = initialConversationState
  private readonly listeners = new Set<() => void>()
  private transitionId = 0
  private detachEvents: (() => void) | undefined

  constructor(private readonly api: ConversationApi) {}

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  getState = (): ConversationState => this.state

  // 订阅主进程事件流；App 在挂载时调用一次。
  attach(): () => void {
    this.detachEvents = this.api.onEvent((event) => {
      this.dispatch({ type: 'generationEvent', event })
      // 完成后会话 updatedAt 变化，刷新列表排序
      if (event.type === 'completed') {
        void this.refreshConversations()
      }
    })
    return () => {
      this.detachEvents?.()
      this.detachEvents = undefined
    }
  }

  // 启动恢复策略：list → 打开最近会话；空库时 create → load。
  async initialize(): Promise<void> {
    const transitionId = ++this.transitionId
    this.dispatch({ type: 'recoverStarted', statusMessage: '正在恢复会话…' })

    try {
      const listed = await this.api.list()
      if (!this.isCurrentTransition(transitionId)) return

      if (listed.status === 'error') {
        this.dispatch({ type: 'recoverFailed', message: listed.error.message })
        return
      }

      this.dispatch({ type: 'conversationsListed', conversations: listed.conversations })
      const latest = listed.conversations[0]
      if (latest) {
        await this.openSession(latest.sessionId, transitionId)
        return
      }

      const created = await this.api.create()
      if (!this.isCurrentTransition(transitionId)) return

      if (created.status === 'error') {
        this.dispatch({ type: 'recoverFailed', message: created.error.message })
        return
      }

      this.dispatch({ type: 'conversationsListed', conversations: [created.conversation] })
      await this.openSession(created.conversation.sessionId, transitionId)
    } catch {
      if (this.isCurrentTransition(transitionId)) {
        this.dispatch({ type: 'recoverFailed', message: GENERIC_LOAD_ERROR })
      }
    }
  }

  async switchSession(sessionId: string): Promise<void> {
    if (sessionId === this.state.sessionId || this.state.commandPending) return
    const transitionId = ++this.transitionId
    this.dispatch({ type: 'recoverStarted', statusMessage: '正在切换会话…' })
    await this.openSession(sessionId, transitionId)
  }

  async startNewConversation(): Promise<void> {
    if (this.state.commandPending) return
    const transitionId = ++this.transitionId
    this.dispatch({ type: 'recoverStarted', statusMessage: '正在创建会话…' })

    const cancelError = await this.stopActiveGenerations()
    if (!this.isCurrentTransition(transitionId)) return
    if (cancelError) {
      this.dispatch({ type: 'transitionFailed', message: cancelError })
      return
    }

    try {
      const created = await this.api.create()
      if (!this.isCurrentTransition(transitionId)) return

      if (created.status === 'error') {
        this.dispatch({ type: 'recoverFailed', message: created.error.message })
        return
      }

      this.dispatch({
        type: 'conversationsListed',
        conversations: [created.conversation, ...this.state.conversations]
      })
      await this.openSession(created.conversation.sessionId, transitionId, false)
    } catch {
      if (this.isCurrentTransition(transitionId)) {
        this.dispatch({ type: 'recoverFailed', message: GENERIC_LOAD_ERROR })
      }
    }
  }

  async send(text: string): Promise<void> {
    const sessionId = this.state.sessionId
    const trimmed = text.trim()
    if (!trimmed || this.state.phase !== 'ready' || !sessionId) return
    if (this.state.commandPending || isGenerating(this.state)) return

    const requestId = crypto.randomUUID()
    this.dispatch({ type: 'commandStarted' })
    try {
      const result = await this.api.send({ requestId, sessionId, text: trimmed })
      if (result.status === 'error') {
        this.dispatch({ type: 'commandFailed', message: result.error.message })
        return
      }
      this.dispatch({ type: 'generationStarted', generation: result.generation })
    } catch {
      this.dispatch({ type: 'commandFailed', message: GENERIC_SEND_ERROR })
      return
    }
    this.dispatch({ type: 'commandSettled' })
  }

  async cancel(): Promise<void> {
    const active = this.activeRequest()
    if (!active) return

    try {
      const result = await this.api.cancel({ requestId: active.requestId })
      if (result.status === 'error') {
        this.dispatch({ type: 'statusMessage', message: result.error.message })
      }
    } catch {
      this.dispatch({ type: 'statusMessage', message: GENERIC_CANCEL_ERROR })
    }
  }

  async retry(userMessageId: string): Promise<void> {
    const sessionId = this.state.sessionId
    if (this.state.phase !== 'ready' || !sessionId) return
    if (this.state.commandPending || isGenerating(this.state)) return
    const target = this.state.messages.find((message) => message.messageId === userMessageId)
    if (!target?.retryable) return

    const requestId = crypto.randomUUID()
    this.dispatch({ type: 'commandStarted' })
    try {
      const result = await this.api.retry({ requestId, sessionId, userMessageId })
      if (result.status === 'error') {
        this.dispatch({ type: 'commandFailed', message: result.error.message })
        return
      }
      this.dispatch({ type: 'generationStarted', generation: result.generation })
    } catch {
      this.dispatch({ type: 'commandFailed', message: GENERIC_RETRY_ERROR })
      return
    }
    this.dispatch({ type: 'commandSettled' })
  }

  private activeRequest():
    | { requestId: string; sessionId: string; userMessageId: string; assistantMessageId: string }
    | undefined {
    const sessionId = this.state.sessionId
    return Object.values(this.state.activeRequests).find(
      (request) => request.sessionId === sessionId
    )
  }

  private async openSession(
    sessionId: string,
    transitionId: number,
    cancelActive = true
  ): Promise<void> {
    const cancelError = cancelActive ? await this.stopActiveGenerations() : undefined
    if (!this.isCurrentTransition(transitionId)) return
    if (cancelError) {
      this.dispatch({ type: 'transitionFailed', message: cancelError })
      return
    }

    try {
      const loaded = await this.api.load({ sessionId })
      if (!this.isCurrentTransition(transitionId)) return

      if (loaded.status === 'error') {
        this.dispatch({ type: 'recoverFailed', message: loaded.error.message })
        return
      }

      this.dispatch({ type: 'conversationLoaded', sessionId, messages: loaded.messages })
    } catch {
      if (this.isCurrentTransition(transitionId)) {
        this.dispatch({ type: 'recoverFailed', message: GENERIC_LOAD_ERROR })
      }
    }
  }

  private async stopActiveGenerations(): Promise<string | undefined> {
    for (const active of Object.values(this.state.activeRequests)) {
      try {
        const result = await this.api.cancel({ requestId: active.requestId })
        if (result.status === 'error') return result.error.message
      } catch {
        return GENERIC_CANCEL_ERROR
      }
    }
    return undefined
  }

  private async refreshConversations(): Promise<void> {
    try {
      const listed = await this.api.list()
      if (listed.status === 'error') {
        this.dispatch({ type: 'statusMessage', message: listed.error.message })
        return
      }
      this.dispatch({ type: 'conversationsListed', conversations: listed.conversations })
    } catch {
      this.dispatch({ type: 'statusMessage', message: GENERIC_LIST_ERROR })
    }
  }

  private isCurrentTransition(transitionId: number): boolean {
    return transitionId === this.transitionId
  }

  private dispatch(action: ConversationAction): void {
    this.state = reduceConversation(this.state, action)
    for (const listener of this.listeners) {
      listener()
    }
  }
}
