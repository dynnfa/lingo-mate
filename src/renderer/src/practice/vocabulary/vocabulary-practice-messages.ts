import type { VocabularyPracticeErrorCode } from '../../../../shared/vocabulary-practice'

type VocabularyPracticeErrorKey =
  | 'errors:vocabularyPractice.untrustedSource'
  | 'errors:vocabularyPractice.invalidInput'
  | 'errors:vocabularyPractice.sessionNotFound'
  | 'errors:vocabularyPractice.busy'
  | 'errors:vocabularyPractice.modelNotConfigured'
  | 'errors:vocabularyPractice.credentialDecryptFailed'
  | 'errors:vocabularyPractice.modelError'
  | 'errors:vocabularyPractice.invalidAnalysis'
  | 'errors:vocabularyPractice.toolCallNotSupported'
  | 'errors:vocabularyPractice.timeout'
  | 'errors:vocabularyPractice.cancelled'
  | 'errors:vocabularyPractice.roundLimit'
  | 'errors:vocabularyPractice.storageFailed'
  | 'errors:vocabularyPractice.unknown'

// 穷尽的显式映射，不使用任意字符串断言绕过 key 校验。
const VOCABULARY_PRACTICE_ERROR_KEYS: Record<
  VocabularyPracticeErrorCode,
  VocabularyPracticeErrorKey
> = {
  UNTRUSTED_SOURCE: 'errors:vocabularyPractice.untrustedSource',
  INVALID_INPUT: 'errors:vocabularyPractice.invalidInput',
  SESSION_NOT_FOUND: 'errors:vocabularyPractice.sessionNotFound',
  BUSY: 'errors:vocabularyPractice.busy',
  MODEL_NOT_CONFIGURED: 'errors:vocabularyPractice.modelNotConfigured',
  CREDENTIAL_DECRYPT_FAILED: 'errors:vocabularyPractice.credentialDecryptFailed',
  MODEL_ERROR: 'errors:vocabularyPractice.modelError',
  INVALID_ANALYSIS: 'errors:vocabularyPractice.invalidAnalysis',
  TOOL_CALL_NOT_SUPPORTED: 'errors:vocabularyPractice.toolCallNotSupported',
  TIMEOUT: 'errors:vocabularyPractice.timeout',
  CANCELLED: 'errors:vocabularyPractice.cancelled',
  ROUND_LIMIT: 'errors:vocabularyPractice.roundLimit',
  STORAGE_FAILED: 'errors:vocabularyPractice.storageFailed',
  UNKNOWN_ERROR: 'errors:vocabularyPractice.unknown'
}

export function vocabularyPracticeErrorKey(
  code: VocabularyPracticeErrorCode
): VocabularyPracticeErrorKey {
  return VOCABULARY_PRACTICE_ERROR_KEYS[code]
}
