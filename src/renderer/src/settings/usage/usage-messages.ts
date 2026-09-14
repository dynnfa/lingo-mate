import type { UsageErrorCode } from '../../../../shared/usage'
import { COMMON_ERROR_KEY_ENTRIES, createErrorKeyResolver } from '../../i18n/error-messages'

type UsageErrorKey =
  | 'errors:usage.readFailed'
  | 'errors:usage.overflow'
  | (typeof COMMON_ERROR_KEY_ENTRIES)[keyof typeof COMMON_ERROR_KEY_ENTRIES]

// 穷尽的显式映射，不使用任意字符串断言绕过 key 校验；跨域错误码走公共条目。
const USAGE_ERROR_KEYS: Record<UsageErrorCode, UsageErrorKey> = {
  ...COMMON_ERROR_KEY_ENTRIES,
  USAGE_READ_FAILED: 'errors:usage.readFailed',
  USAGE_OVERFLOW: 'errors:usage.overflow'
}

const resolveUsageErrorKey = createErrorKeyResolver(COMMON_ERROR_KEY_ENTRIES)

export function usageErrorKey(code: UsageErrorCode): UsageErrorKey {
  return resolveUsageErrorKey(USAGE_ERROR_KEYS, code)
}
