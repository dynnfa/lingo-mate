import type {
  ChatChannelConnectionErrorCode,
  ChatChannelConnectionState,
  ChatChannelsErrorCode
} from '../../../../shared/chat-channels'
import { COMMON_ERROR_KEY_ENTRIES, createErrorKeyResolver } from '../../i18n/error-messages'

type CommonErrorKey = (typeof COMMON_ERROR_KEY_ENTRIES)[keyof typeof COMMON_ERROR_KEY_ENTRIES]

export type ChannelsErrorKey =
  | CommonErrorKey
  | 'errors:chatChannels.networkError'
  | 'errors:chatChannels.readFailed'
  | 'errors:chatChannels.writeFailed'
  | 'errors:chatChannels.credentialStorageUnavailable'
  | 'errors:chatChannels.tokenInvalid'
  | 'errors:chatChannels.webhookConflict'
  | 'errors:chatChannels.duplicatePolling'
  | 'errors:chatChannels.noConnection'
  | 'errors:chatChannels.alreadyConnected'
  | 'errors:chatChannels.notConnected'
  | 'errors:chatChannels.noPendingBinding'
  | 'errors:chatChannels.noActiveBinding'

// 穷尽的显式映射：新增错误码在编译期暴露漏配站点。
const CHANNELS_ERROR_KEYS: Record<ChatChannelsErrorCode, ChannelsErrorKey> = {
  ...COMMON_ERROR_KEY_ENTRIES,
  CHANNELS_READ_FAILED: 'errors:chatChannels.readFailed',
  CHANNELS_WRITE_FAILED: 'errors:chatChannels.writeFailed',
  CREDENTIAL_STORAGE_UNAVAILABLE: 'errors:chatChannels.credentialStorageUnavailable',
  TOKEN_INVALID: 'errors:chatChannels.tokenInvalid',
  WEBHOOK_CONFLICT: 'errors:chatChannels.webhookConflict',
  DUPLICATE_POLLING: 'errors:chatChannels.duplicatePolling',
  NO_CONNECTION: 'errors:chatChannels.noConnection',
  ALREADY_CONNECTED: 'errors:chatChannels.alreadyConnected',
  NOT_CONNECTED: 'errors:chatChannels.notConnected',
  NO_PENDING_BINDING_REQUEST: 'errors:chatChannels.noPendingBinding',
  NO_ACTIVE_BINDING: 'errors:chatChannels.noActiveBinding'
}

const resolveChannelsErrorKey = createErrorKeyResolver(COMMON_ERROR_KEY_ENTRIES)

export function channelsErrorKey(code: ChatChannelsErrorCode): ChannelsErrorKey {
  return resolveChannelsErrorKey(CHANNELS_ERROR_KEYS, code)
}

export type ChannelsStateKey =
  | 'common:settings.chatChannels.state.connected'
  | 'common:settings.chatChannels.state.connecting'
  | 'common:settings.chatChannels.state.disconnected'
  | 'common:settings.chatChannels.state.error'

// 连接运行状态的文案 key：错误态附带可操作提示。
export function connectionStateKey(state: ChatChannelConnectionState): ChannelsStateKey {
  if (state === 'connected') return 'common:settings.chatChannels.state.connected'
  if (state === 'connecting') return 'common:settings.chatChannels.state.connecting'
  if (state === 'error') return 'common:settings.chatChannels.state.error'
  return 'common:settings.chatChannels.state.disconnected'
}

// 连接错误码与请求错误码是两个枚举（连接侧多 NETWORK_ERROR），分别穷尽映射。
const CONNECTION_ERROR_KEYS: Record<ChatChannelConnectionErrorCode, ChannelsErrorKey> = {
  TOKEN_INVALID: 'errors:chatChannels.tokenInvalid',
  WEBHOOK_CONFLICT: 'errors:chatChannels.webhookConflict',
  DUPLICATE_POLLING: 'errors:chatChannels.duplicatePolling',
  NETWORK_ERROR: 'errors:chatChannels.networkError',
  CHANNELS_WRITE_FAILED: 'errors:chatChannels.writeFailed',
  UNKNOWN_ERROR: 'errors:common.unknown'
}

export function connectionErrorCodeKey(code: ChatChannelConnectionErrorCode): ChannelsErrorKey {
  return CONNECTION_ERROR_KEYS[code]
}
