import { BrowserWindow } from 'electron'
import {
  CHAT_CHANNELS_IPC,
  type ChatChannelConnectionErrorCode,
  type ChatChannelConnectionState,
  type ChatChannelsError,
  type ChatChannelsEvent,
  chatChannelsEventSchema,
  chatChannelsStatusResultSchema,
  configureChatChannelConnectionInputSchema,
  configureChatChannelConnectionResultSchema,
  connectChatChannelResultSchema,
  confirmBindingResultSchema,
  disconnectChatChannelResultSchema,
  issueBindingCodeResultSchema,
  rejectBindingResultSchema,
  unbindChatChannelResultSchema
} from '../shared/chat-channels'
import { noInputSchema, type RegisterTrustedHandler, type TrustedHandlerConfig } from './ipc-guard'
import { ChatChannelsService, ChatChannelsServiceError } from './chat-channels-service'

// 聊天平台设置 IPC：全部请求经可信注册器，结果完整校验；错误只回传安全码。

const CHAT_CHANNELS_ERROR_CODES: ReadonlySet<string> = new Set([
  'UNTRUSTED_SOURCE',
  'INVALID_INPUT',
  'UNKNOWN_ERROR',
  'CHANNELS_READ_FAILED',
  'CHANNELS_WRITE_FAILED',
  'CREDENTIAL_STORAGE_UNAVAILABLE',
  'TOKEN_INVALID',
  'WEBHOOK_CONFLICT',
  'DUPLICATE_POLLING',
  'NO_CONNECTION',
  'ALREADY_CONNECTED',
  'NOT_CONNECTED',
  'NO_PENDING_BINDING_REQUEST',
  'NO_ACTIVE_BINDING'
])

function toSafeChatChannelsError(error: unknown): ChatChannelsError {
  if (error instanceof ChatChannelsServiceError && CHAT_CHANNELS_ERROR_CODES.has(error.code)) {
    return { code: error.code }
  }
  return { code: 'UNKNOWN_ERROR' }
}

function invalidInputError(): ChatChannelsError {
  return { code: 'INVALID_INPUT' }
}

export function registerChatChannelsIpc(
  service: ChatChannelsService,
  registerTrustedHandler: RegisterTrustedHandler
): () => void {
  const removeGetStatus = registerTrustedHandler({
    channel: CHAT_CHANNELS_IPC.getStatus,
    inputSchema: noInputSchema,
    resultSchema: chatChannelsStatusResultSchema,
    invalidInputError,
    mapError: () => ({ code: 'CHANNELS_READ_FAILED' }),
    fallbackError: { code: 'CHANNELS_READ_FAILED' },
    handler: () => ({ status: 'ok' as const, ...service.getStatus() })
  } satisfies TrustedHandlerConfig<typeof noInputSchema, typeof chatChannelsStatusResultSchema>)

  const removeConfigure = registerTrustedHandler({
    channel: CHAT_CHANNELS_IPC.configureConnection,
    inputSchema: configureChatChannelConnectionInputSchema,
    resultSchema: configureChatChannelConnectionResultSchema,
    invalidInputError,
    mapError: toSafeChatChannelsError,
    fallbackError: { code: 'CHANNELS_WRITE_FAILED' },
    handler: async (input) => ({
      status: 'ok' as const,
      connection: await service.configureConnection(input.token)
    })
  } satisfies TrustedHandlerConfig<
    typeof configureChatChannelConnectionInputSchema,
    typeof configureChatChannelConnectionResultSchema
  >)

  const removeConnect = registerTrustedHandler({
    channel: CHAT_CHANNELS_IPC.connect,
    inputSchema: noInputSchema,
    resultSchema: connectChatChannelResultSchema,
    invalidInputError,
    mapError: toSafeChatChannelsError,
    fallbackError: { code: 'UNKNOWN_ERROR' },
    handler: async () => {
      await service.connect()
      return { status: 'ok' as const }
    }
  } satisfies TrustedHandlerConfig<typeof noInputSchema, typeof connectChatChannelResultSchema>)

  const removeDisconnect = registerTrustedHandler({
    channel: CHAT_CHANNELS_IPC.disconnect,
    inputSchema: noInputSchema,
    resultSchema: disconnectChatChannelResultSchema,
    invalidInputError,
    mapError: toSafeChatChannelsError,
    fallbackError: { code: 'UNKNOWN_ERROR' },
    handler: async () => {
      await service.disconnect()
      return { status: 'ok' as const }
    }
  } satisfies TrustedHandlerConfig<typeof noInputSchema, typeof disconnectChatChannelResultSchema>)

  const removeIssueBindingCode = registerTrustedHandler({
    channel: CHAT_CHANNELS_IPC.issueBindingCode,
    inputSchema: noInputSchema,
    resultSchema: issueBindingCodeResultSchema,
    invalidInputError,
    mapError: toSafeChatChannelsError,
    fallbackError: { code: 'CHANNELS_WRITE_FAILED' },
    handler: async () => {
      const issued = await service.issueBindingCode()
      return { status: 'ok' as const, code: issued }
    }
  } satisfies TrustedHandlerConfig<typeof noInputSchema, typeof issueBindingCodeResultSchema>)

  const removeConfirmBinding = registerTrustedHandler({
    channel: CHAT_CHANNELS_IPC.confirmBinding,
    inputSchema: noInputSchema,
    resultSchema: confirmBindingResultSchema,
    invalidInputError,
    mapError: toSafeChatChannelsError,
    fallbackError: { code: 'CHANNELS_WRITE_FAILED' },
    handler: async () => ({
      status: 'ok' as const,
      binding: await service.confirmBinding()
    })
  } satisfies TrustedHandlerConfig<typeof noInputSchema, typeof confirmBindingResultSchema>)

  const removeRejectBinding = registerTrustedHandler({
    channel: CHAT_CHANNELS_IPC.rejectBinding,
    inputSchema: noInputSchema,
    resultSchema: rejectBindingResultSchema,
    invalidInputError,
    mapError: toSafeChatChannelsError,
    fallbackError: { code: 'CHANNELS_WRITE_FAILED' },
    handler: async () => {
      await service.rejectPendingBinding()
      return { status: 'ok' as const }
    }
  } satisfies TrustedHandlerConfig<typeof noInputSchema, typeof rejectBindingResultSchema>)

  const removeUnbind = registerTrustedHandler({
    channel: CHAT_CHANNELS_IPC.unbind,
    inputSchema: noInputSchema,
    resultSchema: unbindChatChannelResultSchema,
    invalidInputError,
    mapError: toSafeChatChannelsError,
    fallbackError: { code: 'CHANNELS_WRITE_FAILED' },
    handler: async () => {
      await service.unbind()
      return { status: 'ok' as const }
    }
  } satisfies TrustedHandlerConfig<typeof noInputSchema, typeof unbindChatChannelResultSchema>)

  return () => {
    removeGetStatus()
    removeConfigure()
    removeConnect()
    removeDisconnect()
    removeIssueBindingCode()
    removeConfirmBinding()
    removeRejectBinding()
    removeUnbind()
  }
}

// Main → Renderer 推送：广播到全部应用窗口（均为可信页面），发送前按
// schema 校验；销毁中的窗口自动跳过。
export function broadcastChatChannelsEvent(event: ChatChannelsEvent): void {
  const parsed = chatChannelsEventSchema.safeParse(event)
  if (!parsed.success) return
  for (const window of BrowserWindow.getAllWindows()) {
    if (window.webContents.isDestroyed()) continue
    window.webContents.send(CHAT_CHANNELS_IPC.event, parsed.data)
  }
}

// 连接状态广播：附带当前连接 ID；无连接时跳过。
export function createChatChannelsStateBroadcaster(
  connectionId: () => string | undefined
): (state: ChatChannelConnectionState, errorCode?: ChatChannelConnectionErrorCode) => void {
  return (state, errorCode) => {
    const id = connectionId()
    if (!id) return
    broadcastChatChannelsEvent({
      type: 'connectionStateChanged',
      connectionId: id,
      state,
      ...(errorCode ? { errorCode } : {})
    })
  }
}
