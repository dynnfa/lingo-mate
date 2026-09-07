import type { UsageErrorCode } from '../../../shared/usage'

type UsageErrorKey =
  | 'errors:usage.untrustedSource'
  | 'errors:usage.invalidInput'
  | 'errors:usage.readFailed'
  | 'errors:usage.overflow'
  | 'errors:usage.unknown'

// 穷尽的显式映射，不使用任意字符串断言绕过 key 校验。
const USAGE_ERROR_KEYS: Record<UsageErrorCode, UsageErrorKey> = {
  UNTRUSTED_SOURCE: 'errors:usage.untrustedSource',
  INVALID_INPUT: 'errors:usage.invalidInput',
  USAGE_READ_FAILED: 'errors:usage.readFailed',
  USAGE_OVERFLOW: 'errors:usage.overflow',
  UNKNOWN_ERROR: 'errors:usage.unknown'
}

export function usageErrorKey(code: UsageErrorCode): UsageErrorKey {
  return USAGE_ERROR_KEYS[code]
}
