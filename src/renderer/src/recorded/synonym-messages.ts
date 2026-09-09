import type { SynonymManagementErrorCode } from '../../../shared/synonym'

type SynonymManagementErrorKey =
  | 'errors:synonym.storageFailed'
  | 'errors:synonym.invalidInput'
  | 'errors:synonym.untrustedSource'
  | 'errors:synonym.unknown'

// 穷尽的显式映射，不使用任意字符串断言绕过 key 校验。
const SYNONYM_MANAGEMENT_ERROR_KEYS: Record<SynonymManagementErrorCode, SynonymManagementErrorKey> =
  {
    STORAGE_FAILED: 'errors:synonym.storageFailed',
    INVALID_INPUT: 'errors:synonym.invalidInput',
    UNTRUSTED_SOURCE: 'errors:synonym.untrustedSource',
    UNKNOWN_ERROR: 'errors:synonym.unknown'
  }

export function synonymManagementErrorKey(
  code: SynonymManagementErrorCode
): SynonymManagementErrorKey {
  return SYNONYM_MANAGEMENT_ERROR_KEYS[code]
}
