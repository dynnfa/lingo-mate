import type { WebContents } from 'electron'
import { ipcMain } from 'electron'
import type {
  ConversationEventListener,
  ConversationModule
} from '../core/conversation/conversation-module'
import {
  cancelMessageInputSchema,
  CONVERSATION_CHANNELS,
  conversationEventSchema,
  loadConversationInputSchema,
  retryMessageInputSchema,
  sendMessageInputSchema,
  type CancelMessageResult,
  type ConversationEvent,
  type CreateConversationResult,
  type GenerationAccepted,
  type ListConversationsResult,
  type LoadConversationResult,
  type RetryMessageInput,
  type RetryMessageResult,
  type SendMessageResult
} from '../shared/conversation'
import { toSafeRequestError } from './conversation-errors'

interface RequestOwnership {
  senderId: number
  senderDestroyed: boolean
}

export function registerConversationIpc(module: ConversationModule): void {
  // sender 所有权：只有创建请求的 WebContents 能取消它；sender 销毁时取消其全部请求。
  const requestOwners = new Map<string, RequestOwnership>()

  ipcMain.handle(CONVERSATION_CHANNELS.create, async (): Promise<CreateConversationResult> => {
    try {
      return { status: 'ok', conversation: await module.createConversation() }
    } catch (error) {
      return { status: 'error', error: toSafeRequestError(error) }
    }
  })

  ipcMain.handle(CONVERSATION_CHANNELS.list, async (): Promise<ListConversationsResult> => {
    try {
      return { status: 'ok', conversations: await module.listConversations() }
    } catch (error) {
      return { status: 'error', error: toSafeRequestError(error) }
    }
  })

  ipcMain.handle(
    CONVERSATION_CHANNELS.load,
    async (_event, rawInput: unknown): Promise<LoadConversationResult> => {
      const input = loadConversationInputSchema.parse(rawInput)
      try {
        return { status: 'ok', ...(await module.loadConversation(input.sessionId)) }
      } catch (error) {
        return { status: 'error', error: toSafeRequestError(error) }
      }
    }
  )

  ipcMain.handle(
    CONVERSATION_CHANNELS.send,
    async (event, rawInput: unknown): Promise<SendMessageResult> => {
      const input = sendMessageInputSchema.parse(rawInput)
      return runGeneration(module, requestOwners, event.sender, input.requestId, (emit) =>
        module.sendMessage(input, emit)
      )
    }
  )

  ipcMain.handle(
    CONVERSATION_CHANNELS.retry,
    async (event, rawInput: unknown): Promise<RetryMessageResult> => {
      const input: RetryMessageInput = retryMessageInputSchema.parse(rawInput)
      return runGeneration(module, requestOwners, event.sender, input.requestId, (emit) =>
        module.retryMessage(input, emit)
      )
    }
  )

  ipcMain.handle(CONVERSATION_CHANNELS.cancel, (event, rawInput: unknown): CancelMessageResult => {
    const input = cancelMessageInputSchema.parse(rawInput)
    if (requestOwners.get(input.requestId)?.senderId !== event.sender.id) {
      return {
        status: 'error',
        error: { code: 'REQUEST_NOT_FOUND', message: '没有找到可取消的回复请求。' }
      }
    }

    try {
      module.cancelMessage(input.requestId)
      return { status: 'ok' }
    } catch (error) {
      return { status: 'error', error: toSafeRequestError(error) }
    }
  })
}

async function runGeneration(
  module: ConversationModule,
  requestOwners: Map<string, RequestOwnership>,
  sender: WebContents,
  requestId: string,
  run: (emit: ConversationEventListener) => Promise<GenerationAccepted>
): Promise<SendMessageResult | RetryMessageResult> {
  if (requestOwners.has(requestId)) {
    return {
      status: 'error',
      error: { code: 'REQUEST_BUSY', message: '该回复请求已在处理中。' }
    }
  }

  const ownership: RequestOwnership = { senderId: sender.id, senderDestroyed: false }

  const releaseOwnership = (): void => {
    if (requestOwners.get(requestId) !== ownership) return
    requestOwners.delete(requestId)
    sender.removeListener('destroyed', onSenderDestroyed)
  }

  const onSenderDestroyed = (): void => {
    if (requestOwners.get(requestId) !== ownership) return
    ownership.senderDestroyed = true
    try {
      module.cancelMessage(requestId)
    } catch {
      // Core 可能仍在校验会话；接受请求后会再次取消。
    }
  }

  const emit: ConversationEventListener = (conversationEvent: ConversationEvent): void => {
    sendEvent(sender, conversationEventSchema.parse(conversationEvent))
    // 任意终态后释放 sender 所有权，避免映射在异常路径下残留。
    if (
      conversationEvent.type === 'completed' ||
      conversationEvent.type === 'cancelled' ||
      conversationEvent.type === 'failed'
    ) {
      releaseOwnership()
    }
  }

  // 在调用 Core 前声明所有权；若 sender 比 Core 注册 execution 更早销毁，
  // 记录该事实并在请求被接受后再次取消。
  requestOwners.set(requestId, ownership)
  sender.on('destroyed', onSenderDestroyed)
  try {
    const result = await run(emit)
    if (ownership.senderDestroyed) {
      try {
        module.cancelMessage(requestId)
      } catch {
        // 请求可能已经同步进入终态；所有权会由终态或下面的清理释放。
        releaseOwnership()
      }
    }
    return { status: 'ok', ...result }
  } catch (error) {
    releaseOwnership()
    return { status: 'error', error: toSafeRequestError(error) }
  }
}

function sendEvent(sender: WebContents, event: unknown): void {
  if (!sender.isDestroyed()) {
    sender.send(CONVERSATION_CHANNELS.event, event)
  }
}
