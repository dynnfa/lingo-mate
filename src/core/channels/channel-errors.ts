// 渠道领域错误：跨模块边界只携带安全错误码，原始原因留在产生处。

export type ChannelErrorCode = 'NO_CONNECTION' | 'NO_PENDING_BINDING_REQUEST' | 'NO_ACTIVE_BINDING'

export class ChannelError extends Error {
  constructor(readonly code: ChannelErrorCode) {
    super(`Channel error: ${code}`)
    this.name = 'ChannelError'
  }
}
