import type { PhraseManagementErrorCode } from '../../../shared/phrase'

type PhraseManagementErrorKey =
  | 'errors:phrase.storageFailed'
  | 'errors:phrase.invalidInput'
  | 'errors:phrase.untrustedSource'
  | 'errors:phrase.unknown'

// 穷尽的显式映射，不使用任意字符串断言绕过 key 校验。
const PHRASE_MANAGEMENT_ERROR_KEYS: Record<PhraseManagementErrorCode, PhraseManagementErrorKey> = {
  STORAGE_FAILED: 'errors:phrase.storageFailed',
  INVALID_INPUT: 'errors:phrase.invalidInput',
  UNTRUSTED_SOURCE: 'errors:phrase.untrustedSource',
  UNKNOWN_ERROR: 'errors:phrase.unknown'
}

export function phraseManagementErrorKey(
  code: PhraseManagementErrorCode
): PhraseManagementErrorKey {
  return PHRASE_MANAGEMENT_ERROR_KEYS[code]
}
