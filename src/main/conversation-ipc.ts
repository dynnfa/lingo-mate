import type { WebContents } from 'electron'
import type {
  ConversationEventListener,
  ConversationModule
} from '../core/conversation/conversation-module'
import {
  cancelMessageInputSchema,
  cancelMessageResultSchema,
  CONVERSATION_CHANNELS,
  conversationEventSchema,
  createConversationResultSchema,
  listConversationsResultSchema,
  loadConversationInputSchema,
  loadConversationResultSchema,
  retryMessageInputSchema,
  retryMessageResultSchema,
  runConversationSkillInputSchema,
  runConversationSkillResultSchema,
  sendMessageInputSchema,
  sendMessageResultSchema,
  type ConversationEvent,
  type GenerationAccepted,
  type RetryMessageResult,
  type RunConversationSkillResult,
  type SendMessageResult
} from '../shared/conversation'
import { toSafeRequestError } from './conversation-errors'
import { noInputSchema, type RegisterTrustedHandler, type TrustedHandlerConfig } from './ipc-guard'

interface RequestOwnership {
  senderId: number
  senderDestroyed: boolean
}

// 注册会话请求入口；来源检查、输入与结果校验由公共守卫统一执行。
// sender 所有权、取消与流式终态处理保留在本模块。
export function registerConversationIpc(
  module: ConversationModule,
  registerTrustedHandler: RegisterTrustedHandler
): () => void {
  // sender 所有权：只有创建请求的 WebContents 能取消它；sender 销毁时取消其全部请求。
  const requestOwners = new Map<string, RequestOwnership>()

  const cleanups = [
    registerTrustedHandler({
      channel: CONVERSATION_CHANNELS.create,
      inputSchema: noInputSchema,
      resultSchema: createConversationResultSchema,
      invalidInputError: () => ({ code: 'INVALID_INPUT' }),
      mapError: toSafeRequestError,
      fallbackError: { code: 'UNKNOWN_ERROR' },
      handler: async () => ({ status: 'ok', conversation: await module.createConversation() })
    } satisfies TrustedHandlerConfig<typeof noInputSchema, typeof createConversationResultSchema>),

    registerTrustedHandler({
      channel: CONVERSATION_CHANNELS.list,
      inputSchema: noInputSchema,
      resultSchema: listConversationsResultSchema,
      invalidInputError: () => ({ code: 'INVALID_INPUT' }),
      mapError: toSafeRequestError,
      fallbackError: { code: 'UNKNOWN_ERROR' },
      handler: async () => ({ status: 'ok', conversations: await module.listConversations() })
    } satisfies TrustedHandlerConfig<typeof noInputSchema, typeof listConversationsResultSchema>),

    registerTrustedHandler({
      channel: CONVERSATION_CHANNELS.load,
      inputSchema: loadConversationInputSchema,
      resultSchema: loadConversationResultSchema,
      invalidInputError: () => ({ code: 'INVALID_INPUT' }),
      mapError: toSafeRequestError,
      fallbackError: { code: 'UNKNOWN_ERROR' },
      handler: async (input) => ({
        status: 'ok',
        ...(await module.loadConversation(input.sessionId))
      })
    } satisfies TrustedHandlerConfig<
      typeof loadConversationInputSchema,
      typeof loadConversationResultSchema
    >),

    registerTrustedHandler({
      channel: CONVERSATION_CHANNELS.runSkill,
      inputSchema: runConversationSkillInputSchema,
      resultSchema: runConversationSkillResultSchema,
      invalidInputError: () => ({ code: 'INVALID_INPUT' }),
      mapError: toSafeRequestError,
      fallbackError: { code: 'UNKNOWN_ERROR' },
      handler: (input, { sender }) =>
        runGeneration(module, requestOwners, sender, input.requestId, (emit) =>
          module.runSkill(input, emit)
        )
    } satisfies TrustedHandlerConfig<
      typeof runConversationSkillInputSchema,
      typeof runConversationSkillResultSchema
    >),

    registerTrustedHandler({
      channel: CONVERSATION_CHANNELS.send,
      inputSchema: sendMessageInputSchema,
      resultSchema: sendMessageResultSchema,
      invalidInputError: () => ({ code: 'INVALID_INPUT' }),
      mapError: toSafeRequestError,
      fallbackError: { code: 'UNKNOWN_ERROR' },
      handler: (input, { sender }) =>
        runGeneration(module, requestOwners, sender, input.requestId, (emit) =>
          module.sendMessage(input, emit)
        )
    } satisfies TrustedHandlerConfig<
      typeof sendMessageInputSchema,
      typeof sendMessageResultSchema
    >),

    registerTrustedHandler({
      channel: CONVERSATION_CHANNELS.retry,
      inputSchema: retryMessageInputSchema,
      resultSchema: retryMessageResultSchema,
      invalidInputError: () => ({ code: 'INVALID_INPUT' }),
      mapError: toSafeRequestError,
      fallbackError: { code: 'UNKNOWN_ERROR' },
      handler: (input, { sender }) =>
        runGeneration(module, requestOwners, sender, input.requestId, (emit) =>
          module.retryMessage(input, emit)
        )
    } satisfies TrustedHandlerConfig<
      typeof retryMessageInputSchema,
      typeof retryMessageResultSchema
    >),

    registerTrustedHandler({
      channel: CONVERSATION_CHANNELS.cancel,
      inputSchema: cancelMessageInputSchema,
      resultSchema: cancelMessageResultSchema,
      invalidInputError: () => ({ code: 'INVALID_INPUT' }),
      mapError: toSafeRequestError,
      fallbackError: { code: 'UNKNOWN_ERROR' },
      handler: (input, { sender }) => {
        if (requestOwners.get(input.requestId)?.senderId !== sender.id) {
          return { status: 'error', error: { code: 'REQUEST_NOT_FOUND' } }
        }
        module.cancelMessage(input.requestId)
        return { status: 'ok' }
      }
    } satisfies TrustedHandlerConfig<
      typeof cancelMessageInputSchema,
      typeof cancelMessageResultSchema
    >)
  ]

  return () => {
    for (const cleanup of cleanups) cleanup()
  }
}

async function runGeneration(
  module: ConversationModule,
  requestOwners: Map<string, RequestOwnership>,
  sender: WebContents,
  requestId: string,
  run: (emit: ConversationEventListener) => Promise<GenerationAccepted>
): Promise<SendMessageResult | RetryMessageResult | RunConversationSkillResult> {
  if (requestOwners.has(requestId)) {
    return { status: 'error', error: { code: 'REQUEST_BUSY' } }
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

// Main → Renderer 的推送事件不属于请求注册器：继续使用现有事件 schema。
function sendEvent(sender: WebContents, event: unknown): void {
  if (!sender.isDestroyed()) {
    sender.send(CONVERSATION_CHANNELS.event, event)
  }
}
