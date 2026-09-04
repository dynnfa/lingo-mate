import { ipcMain } from 'electron'
import {
  localeSettingsSchema,
  PREFERENCES_CHANNELS,
  setLocaleInputSchema,
  type GetLocaleResult,
  type SetLocaleResult
} from '../shared/preferences'
import type { PreferencesService } from './preferences'

// 偏好 IPC 的窄接口：输入与返回值都经过校验，失败只暴露安全错误码，
// 存储读写异常等内部原因不跨越进程边界。
export function registerPreferencesIpc(service: PreferencesService): void {
  ipcMain.handle(PREFERENCES_CHANNELS.getLocale, (): GetLocaleResult => {
    try {
      return { status: 'ok', settings: localeSettingsSchema.parse(service.getLocale()) }
    } catch {
      return { status: 'error', error: { code: 'PREFERENCES_READ_FAILED' } }
    }
  })

  ipcMain.handle(PREFERENCES_CHANNELS.setLocale, (_event, rawInput: unknown): SetLocaleResult => {
    const input = setLocaleInputSchema.safeParse(rawInput)
    if (!input.success) {
      return { status: 'error', error: { code: 'INVALID_LOCALE' } }
    }

    try {
      return {
        status: 'ok',
        settings: localeSettingsSchema.parse(service.setLocale(input.data.preference))
      }
    } catch {
      return { status: 'error', error: { code: 'PREFERENCES_WRITE_FAILED' } }
    }
  })
}
