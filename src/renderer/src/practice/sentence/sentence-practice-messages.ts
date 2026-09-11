import type { SentencePracticeErrorCode } from '../../../../shared/sentence-practice'

type SentencePracticeErrorKey =
  | 'errors:sentencePractice.untrustedSource'
  | 'errors:sentencePractice.invalidInput'
  | 'errors:sentencePractice.sessionNotFound'
  | 'errors:sentencePractice.busy'
  | 'errors:sentencePractice.modelNotConfigured'
  | 'errors:sentencePractice.credentialDecryptFailed'
  | 'errors:sentencePractice.modelError'
  | 'errors:sentencePractice.invalidAnalysis'
  | 'errors:sentencePractice.timeout'
  | 'errors:sentencePractice.cancelled'
  | 'errors:sentencePractice.storageFailed'
  | 'errors:sentencePractice.unknown'

// 穷尽的显式映射，不使用任意字符串断言绕过 key 校验。
const SENTENCE_PRACTICE_ERROR_KEYS: Record<SentencePracticeErrorCode, SentencePracticeErrorKey> = {
  UNTRUSTED_SOURCE: 'errors:sentencePractice.untrustedSource',
  INVALID_INPUT: 'errors:sentencePractice.invalidInput',
  SESSION_NOT_FOUND: 'errors:sentencePractice.sessionNotFound',
  BUSY: 'errors:sentencePractice.busy',
  MODEL_NOT_CONFIGURED: 'errors:sentencePractice.modelNotConfigured',
  CREDENTIAL_DECRYPT_FAILED: 'errors:sentencePractice.credentialDecryptFailed',
  MODEL_ERROR: 'errors:sentencePractice.modelError',
  INVALID_ANALYSIS: 'errors:sentencePractice.invalidAnalysis',
  TIMEOUT: 'errors:sentencePractice.timeout',
  CANCELLED: 'errors:sentencePractice.cancelled',
  STORAGE_FAILED: 'errors:sentencePractice.storageFailed',
  UNKNOWN_ERROR: 'errors:sentencePractice.unknown'
}

export function sentencePracticeErrorKey(
  code: SentencePracticeErrorCode
): SentencePracticeErrorKey {
  return SENTENCE_PRACTICE_ERROR_KEYS[code]
}
