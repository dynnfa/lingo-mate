import type { SynonymManagementErrorCode } from '../../../../shared/synonym'
import { COMMON_ERROR_KEY_ENTRIES, createErrorKeyResolver } from '../../i18n/error-messages'

type SynonymManagementErrorKey =
  (typeof COMMON_ERROR_KEY_ENTRIES)[keyof typeof COMMON_ERROR_KEY_ENTRIES]

// 穷尽的显式映射，不使用任意字符串断言绕过 key 校验；跨域错误码走公共条目。
const SYNONYM_MANAGEMENT_ERROR_KEYS: Record<SynonymManagementErrorCode, SynonymManagementErrorKey> =
  {
    ...COMMON_ERROR_KEY_ENTRIES
  }

const resolveSynonymErrorKey = createErrorKeyResolver(COMMON_ERROR_KEY_ENTRIES)

export function synonymManagementErrorKey(
  code: SynonymManagementErrorCode
): SynonymManagementErrorKey {
  return resolveSynonymErrorKey(SYNONYM_MANAGEMENT_ERROR_KEYS, code)
}

// useCursorList 以 unknown 透传抛出的错误码；收窄回领域码，未知值按 UNKNOWN_ERROR。
export function toSynonymManagementError(error: unknown): SynonymManagementErrorCode {
  return typeof error === 'string' && error in SYNONYM_MANAGEMENT_ERROR_KEYS
    ? (error as SynonymManagementErrorCode)
    : 'UNKNOWN_ERROR'
}
