import type { ChatChannelPlatform } from '../../shared/chat-channels'
import type { SupportedLocale, TargetLanguage } from '../../shared/preferences'

// 统一入站消息：平台无关。适配器负责把平台事件校验并转换为该形状；
// 出站目标只能从已校验的入站上下文生成，不接受外部指定收件人。

export interface InboundChannelMessage {
  platform: ChatChannelPlatform
  connectionId: string
  botId: string
  // 幂等键的组成为 platform + botId + eventId。
  eventId: number
  messageId: number
  senderId: string
  chatId: string
  sentAt: string
  receivedAt: string
  text: string
  senderName: string | null
}

// 不支持或校验失败的事件：安全推进游标，不保存正文。
export interface IgnoredChannelEvent {
  platform: ChatChannelPlatform
  connectionId: string
  botId: string
  eventId: number
  reason: 'unsupported' | 'invalid'
}

export interface ChannelOutboundTarget {
  platform: ChatChannelPlatform
  connectionId: string
  botId: string
  chatId: string
}

export type ChannelDeliveryOutcome = { delivered: true } | { delivered: false; deferred?: boolean }

export interface ChannelTransport {
  send(target: ChannelOutboundTarget, text: string): Promise<ChannelDeliveryOutcome>
}

// 平台回复文案端口：实现方负责按语言生成静态文本，Core 不加载资源文件。
export interface ChatChannelReplies {
  help(language: SupportedLocale): string
  notBound(language: SupportedLocale): string
  alreadyBound(language: SupportedLocale): string
  bindingRequested(language: SupportedLocale): string
  bindingCodeMismatch(language: SupportedLocale): string
  bindingCodeExpired(language: SupportedLocale): string
  bindingCodeExhausted(language: SupportedLocale): string
  noActiveBindingCode(language: SupportedLocale): string
  confirmationPrompt(
    language: SupportedLocale,
    detail: { words: string[]; targetLanguage: TargetLanguage; operationId: string }
  ): string
  confirmNoPending(language: SupportedLocale): string
  confirmLanguageChanged(
    language: SupportedLocale,
    detail: { words: string[]; targetLanguage: TargetLanguage; operationId: string }
  ): string
  confirmExpired(language: SupportedLocale): string
  intentClarify(language: SupportedLocale): string
  cancelReport(language: SupportedLocale, detail: { cancelled: number }): string
  cancelIdle(language: SupportedLocale): string
  newSessionBusy(language: SupportedLocale): string
  newSessionStarted(language: SupportedLocale): string
  queueBusy(language: SupportedLocale): string
  rateLimited(language: SupportedLocale): string
  messageTooLong(language: SupportedLocale): string
  executionFailed(language: SupportedLocale): string
  needsAttention(language: SupportedLocale): string
}

// 自然语言收藏意图识别端口：无写入能力，只产生候选或澄清。
export type ChannelIntentResult =
  { status: 'save'; words: string[] } | { status: 'clarify' } | { status: 'none' }

export interface ChannelIntentRecognizer {
  recognize(input: {
    text: string
    outputLanguage: SupportedLocale
    targetLanguage: TargetLanguage
    signal: AbortSignal
  }): Promise<ChannelIntentResult>
}

// ---- 持久化记录形状（由 ChannelStore 端口的实现承载） ----

export interface StoredChannelConnection {
  connectionId: string
  platform: ChatChannelPlatform
  botId: string
  botUsername: string | null
  createdAt: string
  updatedAt: string
}

export type StoredChannelBindingStatus = 'pending' | 'active' | 'rejected' | 'unbound'

export interface StoredChannelBinding {
  bindingId: string
  connectionId: string
  platform: ChatChannelPlatform
  senderId: string
  chatId: string
  displayName: string | null
  status: StoredChannelBindingStatus
  requestedAt: string
  confirmedAt: string | null
  unboundAt: string | null
}

export interface StoredChannelBindingCode {
  connectionId: string
  code: string
  createdAt: string
  expiresAt: string
  consumedAt: string | null
  attempts: number
}

export type BindingCodeMatchOutcome = 'matched' | 'mismatch' | 'expired' | 'exhausted' | 'none'

export interface StoredChannelSession {
  sessionId: string
  connectionId: string
  sessionKey: string
  createdAt: string
  updatedAt: string
}

export type ChannelInboundKind = 'command' | 'message' | 'confirmation' | 'ignored'

export type ChannelInboundStatus =
  | 'received'
  | 'pending_confirmation'
  | 'executing'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'expired'
  | 'ignored'
  | 'needs_attention'

export interface ChannelExecutionRef {
  requestId: string
  userMessageId: string
}

export interface StoredChannelInbound {
  inboundId: string
  connectionId: string
  platform: ChatChannelPlatform
  botId: string
  eventId: number
  messageId: number
  chatId: string
  senderId: string
  sentAt: string
  receivedAt: string
  text: string | null
  kind: ChannelInboundKind
  status: ChannelInboundStatus
  sessionId: string | null
  executionRef: ChannelExecutionRef | null
  createdAt: string
  updatedAt: string
}

export type ChannelReplyStatus = 'pending' | 'sent' | 'failed'

export interface StoredChannelReply {
  replyId: string
  connectionId: string
  platform: ChatChannelPlatform
  chatId: string
  senderId: string
  sessionId: string | null
  inboundId: string | null
  text: string
  status: ChannelReplyStatus
  attempts: number
  createdAt: string
  updatedAt: string
  sentAt: string | null
}

export interface StoredChannelConfirmation {
  operationId: string
  connectionId: string
  sessionId: string
  chatId: string
  senderId: string
  messageRef: number
  words: string[]
  targetLanguage: TargetLanguage
  explanationLanguage: SupportedLocale
  createdAt: string
  expiresAt: string
  consumedAt: string | null
}

export interface ChannelConfirmationScope {
  connectionId: string
  sessionId: string
  chatId: string
  senderId: string
}

export type ConsumeConfirmationOutcome =
  | { outcome: 'consumed'; confirmation: StoredChannelConfirmation }
  | { outcome: 'missing' }
  | { outcome: 'expired'; confirmation: StoredChannelConfirmation }

// 会话键由平台、连接、发送者与聊天共同确定；外部消息不能指定桌面 sessionId。
export function channelSessionKey(message: {
  platform: ChatChannelPlatform
  connectionId: string
  senderId: string
  chatId: string
}): string {
  return `${message.platform}:${message.connectionId}:${message.senderId}:${message.chatId}`
}
