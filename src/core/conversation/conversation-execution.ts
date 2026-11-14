import type { ConversationEvent } from '../../shared/conversation'
import type { SupportedLocale, TargetLanguage } from '../../shared/preferences'
import { AgentRuntimeError } from '../agent/agent-runtime'
import {
  ConversationBusyError,
  RequestBusyError,
  RequestNotFoundError
} from './conversation-repository'

export type ConversationEventListener = (event: ConversationEvent) => void

// 一次执行的语言快照；已开始的执行与恢复不受后续设置变更影响。
export interface ConversationLanguages {
  outputLanguage: SupportedLocale
  targetLanguage: TargetLanguage
}

// 一次运行期请求的全部身份：requestId 只用于事件关联与取消，
// user/assistant messageId 是消息在事件、Renderer 与 SQLite 中的唯一身份。
export interface ActiveExecution {
  controller: AbortController
  sessionId: string
  userMessageId: string
  assistantMessageId: string
  languages: ConversationLanguages
}

// 普通回复、数据库技能与文件结果技能共用同一请求归属、取消和退出等待。
export class ConversationExecutions {
  private closed = false
  private readonly idleListeners = new Set<() => void>()
  private readonly titleControllers = new Set<AbortController>()
  private readonly activeRequests = new Map<string, ActiveExecution>()
  private readonly sessionRequests = new Map<string, string>()

  register(requestId: string, execution: ActiveExecution): void {
    if (this.closed) throw new AgentRuntimeError('AGENT_UNAVAILABLE')
    if (this.activeRequests.has(requestId)) {
      throw new RequestBusyError(requestId)
    }

    const runningRequestId = this.sessionRequests.get(execution.sessionId)
    if (runningRequestId && this.activeRequests.has(runningRequestId)) {
      throw new ConversationBusyError(execution.sessionId)
    }

    this.activeRequests.set(requestId, execution)
    this.sessionRequests.set(execution.sessionId, requestId)
  }

  get(requestId: string): ActiveExecution | undefined {
    return this.activeRequests.get(requestId)
  }

  async trackTitle(controller: AbortController, operation: () => Promise<void>): Promise<void> {
    this.titleControllers.add(controller)
    try {
      await operation()
    } finally {
      this.titleControllers.delete(controller)
      this.notifyIdle()
    }
  }

  cancel(requestId: string): void {
    const execution = this.activeRequests.get(requestId)
    if (!execution) {
      throw new RequestNotFoundError(requestId)
    }
    execution.controller.abort()
  }

  async waitForIdle(): Promise<void> {
    if (!this.activeRequests.size && !this.titleControllers.size) return
    await new Promise<void>((resolve) => this.idleListeners.add(resolve))
  }

  private notifyIdle(): void {
    if (this.activeRequests.size || this.titleControllers.size) return
    for (const resolve of this.idleListeners) resolve()
    this.idleListeners.clear()
  }

  dispose(): void {
    this.closed = true
    for (const controller of this.titleControllers) controller.abort()
    for (const execution of this.activeRequests.values()) execution.controller.abort()
  }

  releaseOnTerminal(
    execution: ActiveExecution,
    emit: ConversationEventListener
  ): ConversationEventListener {
    let finished = false
    return (event) => {
      if (finished) return
      if (event.type === 'completed' || event.type === 'cancelled' || event.type === 'failed') {
        finished = true
        // A terminal means the work has settled and the caller can submit again.
        this.release(event.requestId, execution)
      }
      emit(event)
    }
  }

  release(requestId: string, execution: ActiveExecution): void {
    if (this.activeRequests.get(requestId) !== execution) return
    this.activeRequests.delete(requestId)
    if (this.sessionRequests.get(execution.sessionId) === requestId) {
      this.sessionRequests.delete(execution.sessionId)
    }
    this.notifyIdle()
  }
}
