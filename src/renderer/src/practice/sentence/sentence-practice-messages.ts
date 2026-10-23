import type { SentencePracticeErrorCode } from '../../../../shared/sentence-practice'
import { COMMON_ERROR_KEY_ENTRIES, createErrorKeyResolver } from '../../i18n/error-messages'

type CommonErrorKey = (typeof COMMON_ERROR_KEY_ENTRIES)[keyof typeof COMMON_ERROR_KEY_ENTRIES]

type SentencePracticeErrorKey =
  | CommonErrorKey
  | 'errors:generation.agentUnavailable'
  | 'errors:generation.agentProtocol'
  | 'errors:generation.agentLimit'
  | 'errors:sentencePractice.sessionNotFound'
  | 'errors:sentencePractice.busy'
  | 'errors:sentencePractice.modelNotConfigured'
  | 'errors:sentencePractice.credentialDecryptFailed'
  | 'errors:sentencePractice.modelError'
  | 'errors:sentencePractice.invalidAnalysis'
  | 'errors:sentencePractice.timeout'
  | 'errors:sentencePractice.cancelled'

// 穷尽的显式映射，不使用任意字符串断言绕过 key 校验；跨域错误码走公共条目。
const SENTENCE_PRACTICE_ERROR_KEYS: Record<SentencePracticeErrorCode, SentencePracticeErrorKey> = {
  ...COMMON_ERROR_KEY_ENTRIES,
  AGENT_UNAVAILABLE: 'errors:generation.agentUnavailable',
  AGENT_PROTOCOL_ERROR: 'errors:generation.agentProtocol',
  AGENT_LIMIT: 'errors:generation.agentLimit',
  AGENT_HOST_ERROR: 'errors:generation.agentProtocol',
  SESSION_NOT_FOUND: 'errors:sentencePractice.sessionNotFound',
  BUSY: 'errors:sentencePractice.busy',
  MODEL_NOT_CONFIGURED: 'errors:sentencePractice.modelNotConfigured',
  CREDENTIAL_DECRYPT_FAILED: 'errors:sentencePractice.credentialDecryptFailed',
  MODEL_ERROR: 'errors:sentencePractice.modelError',
  INVALID_ANALYSIS: 'errors:sentencePractice.invalidAnalysis',
  TIMEOUT: 'errors:sentencePractice.timeout',
  CANCELLED: 'errors:sentencePractice.cancelled'
}

const resolveSentencePracticeErrorKey = createErrorKeyResolver(COMMON_ERROR_KEY_ENTRIES)

export function sentencePracticeErrorKey(
  code: SentencePracticeErrorCode
): SentencePracticeErrorKey {
  return resolveSentencePracticeErrorKey(SENTENCE_PRACTICE_ERROR_KEYS, code)
}
