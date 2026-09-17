import type { PreferencesErrorCode } from '../../../shared/preferences'
import { COMMON_ERROR_KEY_ENTRIES, createErrorKeyResolver } from '../i18n/error-messages'

type PreferencesErrorKey =
  | 'errors:preferences.readFailed'
  | 'errors:preferences.writeFailed'
  | (typeof COMMON_ERROR_KEY_ENTRIES)[keyof typeof COMMON_ERROR_KEY_ENTRIES]

// 偏好读写失败码到展示文案 key 的统一映射，两个语言区块共用；
// 语言值本身非法沿用保存失败文案，跨域错误码走公共条目。
const PREFERENCES_ERROR_KEYS: Record<PreferencesErrorCode, PreferencesErrorKey> = {
  ...COMMON_ERROR_KEY_ENTRIES,
  PREFERENCES_READ_FAILED: 'errors:preferences.readFailed',
  PREFERENCES_WRITE_FAILED: 'errors:preferences.writeFailed',
  INVALID_UI_LANGUAGE: 'errors:preferences.writeFailed',
  INVALID_TARGET_LANGUAGE: 'errors:preferences.writeFailed'
}

const resolvePreferencesErrorKey = createErrorKeyResolver(COMMON_ERROR_KEY_ENTRIES)

export function preferencesFailureMessageKey(code: PreferencesErrorCode): PreferencesErrorKey {
  return resolvePreferencesErrorKey(PREFERENCES_ERROR_KEYS, code)
}
