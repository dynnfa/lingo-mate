// 渠道内部策略常量：有效期、队列与限流上限。首版不作为用户设置项。

export interface ChannelPolicies {
  // 绑定码：短时有效、一次性，桌面生成后由用户在平台侧发送 /start <code>。
  bindingCodeTtlMs: number
  bindingCodeMaxAttempts: number
  // 自然语言收藏确认的有效期；过期或重启后失效，需重新发起。
  confirmationTtlMs: number
  // 积压消息有效期：应用离线期间的消息过期后不自动执行，需用户重新发起。
  inboundMessageTtlMs: number
  // 入站文本长度上限（与桌面对话输入上限一致）。
  inboundMaxLength: number
  // 同一外部会话的待执行队列长度；超出时反馈忙碌。
  sessionQueueLimit: number
  // 账号速率限制：每个绑定账号在窗口内最多处理的消息数。
  accountRateMaxMessages: number
  accountRateWindowMs: number
  // 待发回复的最大投递尝试次数；超出后标记发送失败，不再自动重试。
  replyMaxAttempts: number
  replyTtlMs: number
}

export const DEFAULT_CHANNEL_POLICIES: ChannelPolicies = {
  bindingCodeTtlMs: 10 * 60_000,
  bindingCodeMaxAttempts: 5,
  confirmationTtlMs: 5 * 60_000,
  inboundMessageTtlMs: 15 * 60_000,
  inboundMaxLength: 4_000,
  sessionQueueLimit: 5,
  accountRateMaxMessages: 20,
  accountRateWindowMs: 60_000,
  replyMaxAttempts: 5,
  replyTtlMs: 24 * 60 * 60_000
}
