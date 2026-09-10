import type { VocabularyManagementErrorCode } from '../../../../shared/vocabulary'

type VocabularyManagementErrorKey =
  | 'errors:vocabulary.storageFailed'
  | 'errors:vocabulary.invalidInput'
  | 'errors:vocabulary.untrustedSource'
  | 'errors:vocabulary.unknown'

// 穷尽的显式映射，不使用任意字符串断言绕过 key 校验。
const VOCABULARY_MANAGEMENT_ERROR_KEYS: Record<
  VocabularyManagementErrorCode,
  VocabularyManagementErrorKey
> = {
  STORAGE_FAILED: 'errors:vocabulary.storageFailed',
  INVALID_INPUT: 'errors:vocabulary.invalidInput',
  UNTRUSTED_SOURCE: 'errors:vocabulary.untrustedSource',
  UNKNOWN_ERROR: 'errors:vocabulary.unknown'
}

export function vocabularyManagementErrorKey(
  code: VocabularyManagementErrorCode
): VocabularyManagementErrorKey {
  return VOCABULARY_MANAGEMENT_ERROR_KEYS[code]
}
