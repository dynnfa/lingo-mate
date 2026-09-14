import type { PhraseManagementErrorCode } from '../../../../shared/phrase'
import { COMMON_ERROR_KEY_ENTRIES, createErrorKeyResolver } from '../../i18n/error-messages'

type PhraseManagementErrorKey =
  (typeof COMMON_ERROR_KEY_ENTRIES)[keyof typeof COMMON_ERROR_KEY_ENTRIES]

// 穷尽的显式映射，不使用任意字符串断言绕过 key 校验；跨域错误码走公共条目。
const PHRASE_MANAGEMENT_ERROR_KEYS: Record<PhraseManagementErrorCode, PhraseManagementErrorKey> = {
  ...COMMON_ERROR_KEY_ENTRIES
}

const resolvePhraseErrorKey = createErrorKeyResolver(COMMON_ERROR_KEY_ENTRIES)

export function phraseManagementErrorKey(
  code: PhraseManagementErrorCode
): PhraseManagementErrorKey {
  return resolvePhraseErrorKey(PHRASE_MANAGEMENT_ERROR_KEYS, code)
}

// useCursorList 以 unknown 透传抛出的错误码；收窄回领域码，未知值按 UNKNOWN_ERROR。
export function toPhraseManagementError(error: unknown): PhraseManagementErrorCode {
  return typeof error === 'string' && error in PHRASE_MANAGEMENT_ERROR_KEYS
    ? (error as PhraseManagementErrorCode)
    : 'UNKNOWN_ERROR'
}
