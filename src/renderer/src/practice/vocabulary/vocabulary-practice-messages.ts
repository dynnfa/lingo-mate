import type { VocabularyPracticeErrorCode } from '../../../../shared/vocabulary-practice'
import { COMMON_ERROR_KEY_ENTRIES, createErrorKeyResolver } from '../../i18n/error-messages'

type CommonErrorKey = (typeof COMMON_ERROR_KEY_ENTRIES)[keyof typeof COMMON_ERROR_KEY_ENTRIES]

type VocabularyPracticeErrorKey =
  | CommonErrorKey
  | 'errors:generation.agentUnavailable'
  | 'errors:generation.agentProtocol'
  | 'errors:generation.agentLimit'
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

// 穷尽的显式映射，不使用任意字符串断言绕过 key 校验；跨域错误码走公共条目。
const VOCABULARY_PRACTICE_ERROR_KEYS: Record<
  VocabularyPracticeErrorCode,
  VocabularyPracticeErrorKey
> = {
  ...COMMON_ERROR_KEY_ENTRIES,
  AGENT_UNAVAILABLE: 'errors:generation.agentUnavailable',
  AGENT_PROTOCOL_ERROR: 'errors:generation.agentProtocol',
  AGENT_LIMIT: 'errors:generation.agentLimit',
  AGENT_HOST_ERROR: 'errors:generation.agentProtocol',
  SESSION_NOT_FOUND: 'errors:vocabularyPractice.sessionNotFound',
  BUSY: 'errors:vocabularyPractice.busy',
  MODEL_NOT_CONFIGURED: 'errors:vocabularyPractice.modelNotConfigured',
  CREDENTIAL_DECRYPT_FAILED: 'errors:vocabularyPractice.credentialDecryptFailed',
  MODEL_ERROR: 'errors:vocabularyPractice.modelError',
  INVALID_ANALYSIS: 'errors:vocabularyPractice.invalidAnalysis',
  TOOL_CALL_NOT_SUPPORTED: 'errors:vocabularyPractice.toolCallNotSupported',
  TIMEOUT: 'errors:vocabularyPractice.timeout',
  CANCELLED: 'errors:vocabularyPractice.cancelled',
  ROUND_LIMIT: 'errors:vocabularyPractice.roundLimit'
}

const resolveVocabularyPracticeErrorKey = createErrorKeyResolver(COMMON_ERROR_KEY_ENTRIES)

export function vocabularyPracticeErrorKey(
  code: VocabularyPracticeErrorCode
): VocabularyPracticeErrorKey {
  return resolveVocabularyPracticeErrorKey(VOCABULARY_PRACTICE_ERROR_KEYS, code)
}
