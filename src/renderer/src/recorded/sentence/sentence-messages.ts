import type { SentenceManagementErrorCode } from '../../../../shared/sentence'
import { COMMON_ERROR_KEY_ENTRIES, createErrorKeyResolver } from '../../i18n/error-messages'

type SentenceManagementErrorKey =
  (typeof COMMON_ERROR_KEY_ENTRIES)[keyof typeof COMMON_ERROR_KEY_ENTRIES]

// 穷尽的显式映射，不使用任意字符串断言绕过 key 校验；跨域错误码走公共条目。
const SENTENCE_MANAGEMENT_ERROR_KEYS: Record<
  SentenceManagementErrorCode,
  SentenceManagementErrorKey
> = {
  ...COMMON_ERROR_KEY_ENTRIES
}

const resolveSentenceErrorKey = createErrorKeyResolver(COMMON_ERROR_KEY_ENTRIES)

export function sentenceManagementErrorKey(
  code: SentenceManagementErrorCode
): SentenceManagementErrorKey {
  return resolveSentenceErrorKey(SENTENCE_MANAGEMENT_ERROR_KEYS, code)
}

// useCursorList 以 unknown 透传抛出的错误码；收窄回领域码，未知值按 UNKNOWN_ERROR。
export function toSentenceManagementError(error: unknown): SentenceManagementErrorCode {
  return typeof error === 'string' && error in SENTENCE_MANAGEMENT_ERROR_KEYS
    ? (error as SentenceManagementErrorCode)
    : 'UNKNOWN_ERROR'
}
