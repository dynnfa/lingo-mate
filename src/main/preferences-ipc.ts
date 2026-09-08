import { ipcMain } from 'electron'
import {
  languageSettingsSchema,
  PREFERENCES_CHANNELS,
  setTargetLanguageInputSchema,
  setUiLanguageInputSchema,
  type GetLanguageSettingsResult,
  type SetTargetLanguageResult,
  type SetUiLanguageResult
} from '../shared/preferences'
import type { PreferencesService } from './preferences'

// 偏好 IPC 的窄接口：输入与返回值都经过校验，失败只暴露安全错误码，
// 存储读写异常等内部原因不跨越进程边界。非法更新明确拒绝，不静默接受。
export function registerPreferencesIpc(service: PreferencesService): void {
  ipcMain.handle(PREFERENCES_CHANNELS.getLanguageSettings, (): GetLanguageSettingsResult => {
    try {
      return {
        status: 'ok',
        settings: languageSettingsSchema.parse(service.getLanguageSettings())
      }
    } catch {
      return { status: 'error', error: { code: 'PREFERENCES_READ_FAILED' } }
    }
  })

  ipcMain.handle(
    PREFERENCES_CHANNELS.setUiLanguage,
    (_event, rawInput: unknown): SetUiLanguageResult => {
      const input = setUiLanguageInputSchema.safeParse(rawInput)
      if (!input.success) {
        return { status: 'error', error: { code: 'INVALID_UI_LANGUAGE' } }
      }

      try {
        return {
          status: 'ok',
          settings: languageSettingsSchema.parse(service.setUiLanguage(input.data.uiLanguage))
        }
      } catch {
        return { status: 'error', error: { code: 'PREFERENCES_WRITE_FAILED' } }
      }
    }
  )

  ipcMain.handle(
    PREFERENCES_CHANNELS.setTargetLanguage,
    (_event, rawInput: unknown): SetTargetLanguageResult => {
      const input = setTargetLanguageInputSchema.safeParse(rawInput)
      if (!input.success) {
        return { status: 'error', error: { code: 'INVALID_TARGET_LANGUAGE' } }
      }

      try {
        return {
          status: 'ok',
          settings: languageSettingsSchema.parse(
            service.setTargetLanguage(input.data.targetLanguage)
          )
        }
      } catch {
        return { status: 'error', error: { code: 'PREFERENCES_WRITE_FAILED' } }
      }
    }
  )
}
