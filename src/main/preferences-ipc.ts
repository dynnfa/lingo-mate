import { noInputSchema, type RegisterTrustedHandler, type TrustedHandlerConfig } from './ipc-guard'
import {
  PREFERENCES_CHANNELS,
  getLanguageSettingsResultSchema,
  setTargetLanguageInputSchema,
  setTargetLanguageResultSchema,
  setUiLanguageInputSchema,
  setUiLanguageResultSchema
} from '../shared/preferences'
import type { PreferencesService } from './preferences'

// 偏好 IPC 的窄接口：来源检查、输入与返回值校验统一由公共守卫执行，
// 失败只暴露安全错误码，存储读写异常等内部原因不跨越进程边界。
// 非法更新明确拒绝，不静默接受。
export function registerPreferencesIpc(
  service: PreferencesService,
  registerTrustedHandler: RegisterTrustedHandler
): () => void {
  const removeGet = registerTrustedHandler({
    channel: PREFERENCES_CHANNELS.getLanguageSettings,
    inputSchema: noInputSchema,
    resultSchema: getLanguageSettingsResultSchema,
    invalidInputError: () => ({ code: 'INVALID_INPUT' }),
    mapError: () => ({ code: 'PREFERENCES_READ_FAILED' }),
    fallbackError: { code: 'PREFERENCES_READ_FAILED' },
    handler: () => ({ status: 'ok', settings: service.getLanguageSettings() })
  } satisfies TrustedHandlerConfig<typeof noInputSchema, typeof getLanguageSettingsResultSchema>)

  const removeSetUi = registerTrustedHandler({
    channel: PREFERENCES_CHANNELS.setUiLanguage,
    inputSchema: setUiLanguageInputSchema,
    resultSchema: setUiLanguageResultSchema,
    invalidInputError: () => ({ code: 'INVALID_UI_LANGUAGE' }),
    mapError: () => ({ code: 'PREFERENCES_WRITE_FAILED' }),
    fallbackError: { code: 'PREFERENCES_WRITE_FAILED' },
    handler: (input) => ({
      status: 'ok',
      settings: service.setUiLanguage(input.uiLanguage)
    })
  } satisfies TrustedHandlerConfig<
    typeof setUiLanguageInputSchema,
    typeof setUiLanguageResultSchema
  >)

  const removeSetTarget = registerTrustedHandler({
    channel: PREFERENCES_CHANNELS.setTargetLanguage,
    inputSchema: setTargetLanguageInputSchema,
    resultSchema: setTargetLanguageResultSchema,
    invalidInputError: () => ({ code: 'INVALID_TARGET_LANGUAGE' }),
    mapError: () => ({ code: 'PREFERENCES_WRITE_FAILED' }),
    fallbackError: { code: 'PREFERENCES_WRITE_FAILED' },
    handler: (input) => ({
      status: 'ok',
      settings: service.setTargetLanguage(input.targetLanguage)
    })
  } satisfies TrustedHandlerConfig<
    typeof setTargetLanguageInputSchema,
    typeof setTargetLanguageResultSchema
  >)

  return () => {
    removeGet()
    removeSetUi()
    removeSetTarget()
  }
}
