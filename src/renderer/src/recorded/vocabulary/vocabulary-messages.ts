import type { VocabularyManagementErrorCode } from '../../../../shared/vocabulary'
import { COMMON_ERROR_KEY_ENTRIES, createErrorKeyResolver } from '../../i18n/error-messages'

type VocabularyManagementErrorKey =
  (typeof COMMON_ERROR_KEY_ENTRIES)[keyof typeof COMMON_ERROR_KEY_ENTRIES]

// 穷尽的显式映射，不使用任意字符串断言绕过 key 校验；跨域错误码走公共条目。
const VOCABULARY_MANAGEMENT_ERROR_KEYS: Record<
  VocabularyManagementErrorCode,
  VocabularyManagementErrorKey
> = {
  ...COMMON_ERROR_KEY_ENTRIES
}

const resolveVocabularyErrorKey = createErrorKeyResolver(COMMON_ERROR_KEY_ENTRIES)

export function vocabularyManagementErrorKey(
  code: VocabularyManagementErrorCode
): VocabularyManagementErrorKey {
  return resolveVocabularyErrorKey(VOCABULARY_MANAGEMENT_ERROR_KEYS, code)
}

// useCursorList 以 unknown 透传抛出的错误码；收窄回领域码，未知值按 UNKNOWN_ERROR。
export function toVocabularyManagementError(error: unknown): VocabularyManagementErrorCode {
  return typeof error === 'string' && error in VOCABULARY_MANAGEMENT_ERROR_KEYS
    ? (error as VocabularyManagementErrorCode)
    : 'UNKNOWN_ERROR'
}
