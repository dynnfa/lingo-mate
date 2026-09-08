import type { PreferencesErrorCode } from '../../../shared/preferences'

// 偏好读写失败码到展示文案 key 的统一映射，两个语言区块共用。
export function preferencesFailureMessageKey(
  code: PreferencesErrorCode
): 'errors:preferences.readFailed' | 'errors:preferences.writeFailed' {
  return code === 'PREFERENCES_READ_FAILED'
    ? 'errors:preferences.readFailed'
    : 'errors:preferences.writeFailed'
}
