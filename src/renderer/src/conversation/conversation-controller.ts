import type { ConversationApi, ConversationSkillId } from '../../../shared/conversation'
import {
  initialConversationState,
  isGenerating,
  reduceConversation,
  type ConversationAction,
  type ConversationState,
  type FailureStatus
} from './conversation-state'

// Conversation Projection 的控制器：持有唯一的投影状态，
// 封装 window.api 调用、事件订阅、会话切换过渡和命令失败处理。
// 状态只保存语义描述；React 视图读取状态、按界面语言翻译并提交 send/cancel/retry 意图。
export class ConversationController {
  private state: ConversationState = initialConversationState
  private readonly listeners = new Set<() => void>()
  private transitionId = 0
  private pendingRequestId: string | undefined
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
      // 首次落库后显示标题；回复完成后刷新 updatedAt 排序。
      if (event.type === 'started' || event.type === 'completed' || event.type === 'titleUpdated') {
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
    this.dispatch({ type: 'loadPhaseStarted', status: { kind: 'restoring' } })

    try {
      const listed = await this.api.list()
      if (!this.isCurrentTransition(transitionId)) return

      if (listed.status === 'error') {
        this.dispatch({
          type: 'recoverFailed',
          status: { kind: 'requestError', operation: 'list', error: listed.error }
        })
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
        this.dispatch({
          type: 'recoverFailed',
          status: { kind: 'requestError', operation: 'create', error: created.error }
        })
        return
      }

      await this.openSession(created.conversation.sessionId, transitionId)
    } catch {
      if (this.isCurrentTransition(transitionId)) {
        // 启动恢复中的任何 IPC 拒绝都归入加载失败语义；刷新语义只用于完成后的列表更新。
        this.dispatch({ type: 'recoverFailed', status: { kind: 'ipcError', operation: 'load' } })
      }
    }
  }

  async switchSession(sessionId: string): Promise<void> {
    if (sessionId === this.state.sessionId || this.state.commandPending) return
    const transitionId = ++this.transitionId
    this.dispatch({ type: 'loadPhaseStarted', status: { kind: 'switching' } })
    await this.openSession(sessionId, transitionId)
  }

  async startNewConversation(): Promise<void> {
    if (this.state.commandPending) return
    const transitionId = ++this.transitionId
    this.dispatch({ type: 'loadPhaseStarted', status: { kind: 'creating' } })

    const cancelFailure = await this.stopActiveGenerations()
    if (!this.isCurrentTransition(transitionId)) return
    if (cancelFailure) {
      this.dispatch({ type: 'transitionFailed', status: cancelFailure })
      return
    }

    try {
      const created = await this.api.create()
      if (!this.isCurrentTransition(transitionId)) return

      if (created.status === 'error') {
        this.dispatch({
          type: 'recoverFailed',
          status: { kind: 'requestError', operation: 'create', error: created.error }
        })
        return
      }

      await this.openSession(created.conversation.sessionId, transitionId, false)
    } catch {
      if (this.isCurrentTransition(transitionId)) {
        this.dispatch({ type: 'recoverFailed', status: { kind: 'ipcError', operation: 'create' } })
      }
    }
  }

  async send(text: string): Promise<boolean> {
    const sessionId = this.state.sessionId
    const trimmed = text.trim()
    if (!trimmed || this.state.phase !== 'ready' || !sessionId) return false
    if (this.state.commandPending || isGenerating(this.state)) return false

    const requestId = crypto.randomUUID()
    this.pendingRequestId = requestId
    this.dispatch({ type: 'commandStarted' })
    try {
      const result = await this.api.send({ requestId, sessionId, text: trimmed })
      if (result.status === 'error') {
        this.dispatch({
          type: 'commandFailed',
          status: { kind: 'requestError', operation: 'send', error: result.error }
        })
        return false
      }
      this.dispatch({ type: 'generationStarted', generation: result.generation })
    } catch {
      this.dispatch({ type: 'commandFailed', status: { kind: 'ipcError', operation: 'send' } })
      return false
    }
    this.dispatch({ type: 'commandSettled' })
    return true
  }

  async runSkill(input: { skillId: ConversationSkillId; text: string }): Promise<boolean> {
    const sessionId = this.state.sessionId
    if (this.state.phase !== 'ready' || !sessionId || !input.text.trim()) return false
    if (this.state.commandPending || isGenerating(this.state)) return false

    const requestId = crypto.randomUUID()
    this.pendingRequestId = requestId
    this.dispatch({ type: 'commandStarted' })
    try {
      const result = await this.api.runSkill({
        requestId,
        sessionId,
        skillId: input.skillId,
        arguments: { text: input.text, wordLanguage: 'en' }
      })
      if (result.status === 'error') {
        this.dispatch({
          type: 'commandFailed',
          status: { kind: 'requestError', operation: 'runSkill', error: result.error }
        })
        return false
      }
      this.dispatch({ type: 'generationStarted', generation: result.generation })
    } catch {
      this.dispatch({
        type: 'commandFailed',
        status: { kind: 'ipcError', operation: 'runSkill' }
      })
      return false
    }
    this.dispatch({ type: 'commandSettled' })
    return true
  }

  async cancel(): Promise<void> {
    const requestId = this.state.commandPending
      ? this.pendingRequestId
      : this.activeRequest()?.requestId
    if (!requestId) return

    try {
      const result = await this.api.cancel({ requestId })
      if (result.status === 'error') {
        this.dispatch({
          type: 'statusChanged',
          status: { kind: 'requestError', operation: 'cancel', error: result.error }
        })
      }
    } catch {
      this.dispatch({ type: 'statusChanged', status: { kind: 'ipcError', operation: 'cancel' } })
    }
  }

  async retry(userMessageId: string): Promise<void> {
    const sessionId = this.state.sessionId
    if (this.state.phase !== 'ready' || !sessionId) return
    if (this.state.commandPending || isGenerating(this.state)) return
    const target = this.state.messages.find((message) => message.messageId === userMessageId)
    if (!target?.retryable) return

    const requestId = crypto.randomUUID()
    this.pendingRequestId = requestId
    this.dispatch({ type: 'commandStarted' })
    try {
      const result = await this.api.retry({ requestId, sessionId, userMessageId })
      if (result.status === 'error') {
        this.dispatch({
          type: 'commandFailed',
          status: { kind: 'requestError', operation: 'retry', error: result.error }
        })
        return
      }
      this.dispatch({ type: 'generationStarted', generation: result.generation })
    } catch {
      this.dispatch({ type: 'commandFailed', status: { kind: 'ipcError', operation: 'retry' } })
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
    const cancelFailure = cancelActive ? await this.stopActiveGenerations() : undefined
    if (!this.isCurrentTransition(transitionId)) return
    if (cancelFailure) {
      this.dispatch({ type: 'transitionFailed', status: cancelFailure })
      return
    }

    try {
      const loaded = await this.api.load({ sessionId })
      if (!this.isCurrentTransition(transitionId)) return

      if (loaded.status === 'error') {
        this.dispatch({
          type: 'recoverFailed',
          status: { kind: 'requestError', operation: 'load', error: loaded.error }
        })
        return
      }

      this.dispatch({ type: 'conversationLoaded', sessionId, messages: loaded.messages })
    } catch {
      if (this.isCurrentTransition(transitionId)) {
        this.dispatch({ type: 'recoverFailed', status: { kind: 'ipcError', operation: 'load' } })
      }
    }
  }

  private async stopActiveGenerations(): Promise<FailureStatus | undefined> {
    for (const active of Object.values(this.state.activeRequests)) {
      try {
        const result = await this.api.cancel({ requestId: active.requestId })
        if (result.status === 'error') {
          return { kind: 'requestError', operation: 'cancel', error: result.error }
        }
      } catch {
        return { kind: 'ipcError', operation: 'cancel' }
      }
    }
    return undefined
  }

  private async refreshConversations(): Promise<void> {
    try {
      const listed = await this.api.list()
      if (listed.status === 'error') {
        this.dispatch({
          type: 'statusChanged',
          status: { kind: 'requestError', operation: 'list', error: listed.error }
        })
        return
      }
      this.dispatch({ type: 'conversationsListed', conversations: listed.conversations })
    } catch {
      this.dispatch({ type: 'statusChanged', status: { kind: 'ipcError', operation: 'list' } })
    }
  }

  private isCurrentTransition(transitionId: number): boolean {
    return transitionId === this.transitionId
  }

  private dispatch(action: ConversationAction): void {
    if (action.type === 'commandSettled' || action.type === 'commandFailed')
      this.pendingRequestId = undefined
    this.state = reduceConversation(this.state, action)
    for (const listener of this.listeners) {
      listener()
    }
  }
}
