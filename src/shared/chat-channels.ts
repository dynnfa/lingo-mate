import { z } from 'zod'

// 聊天平台接入协议：只承载可序列化的设置展示类型、状态、错误码、
// 校验 schema 与 IPC channel，不包含任何运行时实现。

export const CHAT_CHANNELS_IPC = {
  getStatus: 'chatChannels:getStatus',
  configureConnection: 'chatChannels:configureConnection',
  connect: 'chatChannels:connect',
  disconnect: 'chatChannels:disconnect',
  issueBindingCode: 'chatChannels:issueBindingCode',
  confirmBinding: 'chatChannels:confirmBinding',
  rejectBinding: 'chatChannels:rejectBinding',
  unbind: 'chatChannels:unbind',
  event: 'chatChannels:event'
} as const

// 首版仅接入 Telegram；新增平台时先扩展统一入站协议与适配器接口。
export const CHAT_CHANNEL_PLATFORMS = ['telegram'] as const
export type ChatChannelPlatform = (typeof CHAT_CHANNEL_PLATFORMS)[number]
export const chatChannelPlatformSchema = z.enum(CHAT_CHANNEL_PLATFORMS)

const identifierSchema = z.string().uuid()
const timestampSchema = z.iso.datetime()

// 连接运行状态由 Main 的轮询适配器报告；error 分支必须携带安全错误码。
export const chatChannelConnectionStateSchema = z.enum([
  'disconnected',
  'connecting',
  'connected',
  'error'
])
export type ChatChannelConnectionState = z.infer<typeof chatChannelConnectionStateSchema>

export const chatChannelConnectionErrorCodeSchema = z.enum([
  'TOKEN_INVALID',
  'WEBHOOK_CONFLICT',
  'DUPLICATE_POLLING',
  'NETWORK_ERROR',
  'CHANNELS_WRITE_FAILED',
  'UNKNOWN_ERROR'
])
export type ChatChannelConnectionErrorCode = z.infer<typeof chatChannelConnectionErrorCodeSchema>

// 设置页展示的连接视图：不含 Token 等凭据，Token 不提供明文回读；
// state/errorCode 反映 Main 侧轮询适配器的当前运行状态。
export const chatChannelConnectionViewSchema = z.object({
  connectionId: identifierSchema,
  platform: chatChannelPlatformSchema,
  botId: z.string().min(1).max(64),
  botUsername: z.string().min(1).max(64).nullable(),
  state: chatChannelConnectionStateSchema,
  errorCode: chatChannelConnectionErrorCodeSchema.optional(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema
})
export type ChatChannelConnectionView = z.infer<typeof chatChannelConnectionViewSchema>

// 已确认的账号绑定视图。
export const chatChannelBindingViewSchema = z.object({
  bindingId: identifierSchema,
  connectionId: identifierSchema,
  platform: chatChannelPlatformSchema,
  senderId: z.string().min(1).max(64),
  displayName: z.string().min(1).max(128).nullable(),
  boundAt: timestampSchema
})
export type ChatChannelBindingView = z.infer<typeof chatChannelBindingViewSchema>

// 平台侧已发起、等待桌面确认的绑定请求视图。
export const chatChannelPendingBindingRequestViewSchema = z.object({
  bindingId: identifierSchema,
  connectionId: identifierSchema,
  platform: chatChannelPlatformSchema,
  senderId: z.string().min(1).max(64),
  displayName: z.string().min(1).max(128).nullable(),
  requestedAt: timestampSchema
})
export type ChatChannelPendingBindingRequestView = z.infer<
  typeof chatChannelPendingBindingRequestViewSchema
>

// 绑定码视图：短时有效、一次性；下发后由桌面展示给用户。
export const chatChannelBindingCodeViewSchema = z.object({
  code: z.string().min(6).max(12),
  expiresAt: timestampSchema
})
export type ChatChannelBindingCodeView = z.infer<typeof chatChannelBindingCodeViewSchema>

export const chatChannelsErrorSchema = z.object({
  code: z.enum([
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
})
export type ChatChannelsErrorCode = z.infer<typeof chatChannelsErrorSchema>['code']
export type ChatChannelsError = z.infer<typeof chatChannelsErrorSchema>

export const chatChannelsStatusResultSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('ok'),
    connection: chatChannelConnectionViewSchema.nullable(),
    binding: chatChannelBindingViewSchema.nullable(),
    pendingBindingRequest: chatChannelPendingBindingRequestViewSchema.nullable()
  }),
  z.object({ status: z.literal('error'), error: chatChannelsErrorSchema })
])
export type ChatChannelsStatusResult = z.infer<typeof chatChannelsStatusResultSchema>

export const configureChatChannelConnectionInputSchema = z.object({
  // Telegram Bot Token：仅提交给 Main 安全存储，不回读、不写入日志。
  token: z.string().trim().min(1).max(256)
})
export type ConfigureChatChannelConnectionInput = z.infer<
  typeof configureChatChannelConnectionInputSchema
>

export const configureChatChannelConnectionResultSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('ok'), connection: chatChannelConnectionViewSchema }),
  z.object({ status: z.literal('error'), error: chatChannelsErrorSchema })
])
export type ConfigureChatChannelConnectionResult = z.infer<
  typeof configureChatChannelConnectionResultSchema
>

export const connectChatChannelResultSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('ok') }),
  z.object({ status: z.literal('error'), error: chatChannelsErrorSchema })
])
export type ConnectChatChannelResult = z.infer<typeof connectChatChannelResultSchema>

export const disconnectChatChannelResultSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('ok') }),
  z.object({ status: z.literal('error'), error: chatChannelsErrorSchema })
])
export type DisconnectChatChannelResult = z.infer<typeof disconnectChatChannelResultSchema>

export const issueBindingCodeResultSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('ok'), code: chatChannelBindingCodeViewSchema }),
  z.object({ status: z.literal('error'), error: chatChannelsErrorSchema })
])
export type IssueBindingCodeResult = z.infer<typeof issueBindingCodeResultSchema>

export const confirmBindingResultSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('ok'), binding: chatChannelBindingViewSchema }),
  z.object({ status: z.literal('error'), error: chatChannelsErrorSchema })
])
export type ConfirmBindingResult = z.infer<typeof confirmBindingResultSchema>

export const rejectBindingResultSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('ok') }),
  z.object({ status: z.literal('error'), error: chatChannelsErrorSchema })
])
export type RejectBindingResult = z.infer<typeof rejectBindingResultSchema>

export const unbindChatChannelResultSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('ok') }),
  z.object({ status: z.literal('error'), error: chatChannelsErrorSchema })
])
export type UnbindChatChannelResult = z.infer<typeof unbindChatChannelResultSchema>

// Main → Renderer 推送事件：连接状态变化由 Main 主动上报，
// Renderer 订阅后刷新设置页展示。
export const chatChannelsEventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('connectionStateChanged'),
    connectionId: identifierSchema,
    state: chatChannelConnectionStateSchema,
    errorCode: chatChannelConnectionErrorCodeSchema.optional()
  }),
  // 平台侧 /start 已创建待确认绑定：Renderer 刷新状态以展示核对入口。
  z.object({ type: z.literal('bindingRequested') })
])
export type ChatChannelsEvent = z.infer<typeof chatChannelsEventSchema>

export interface ChatChannelsApi {
  getStatus(): Promise<ChatChannelsStatusResult>
  configureConnection(
    input: ConfigureChatChannelConnectionInput
  ): Promise<ConfigureChatChannelConnectionResult>
  connect(): Promise<ConnectChatChannelResult>
  disconnect(): Promise<DisconnectChatChannelResult>
  issueBindingCode(): Promise<IssueBindingCodeResult>
  confirmBinding(): Promise<ConfirmBindingResult>
  rejectBinding(): Promise<RejectBindingResult>
  unbind(): Promise<UnbindChatChannelResult>
  onEvent(listener: (event: ChatChannelsEvent) => void): () => void
}
