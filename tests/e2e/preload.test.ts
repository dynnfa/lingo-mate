import { expect, launchApp, test, withTempUserData } from './helpers'

test('exposes the conversation skill and preferences interfaces from the sandboxed preload', async () => {
  await withTempUserData(async (userDataPath) => {
    const electronApp = await launchApp(userDataPath)
    try {
      const window = await electronApp.firstWindow()

      await expect
        .poll(() =>
          window.evaluate(
            () =>
              typeof (
                globalThis as typeof globalThis & { api?: { conversation?: { send?: unknown } } }
              ).api?.conversation?.send
          )
        )
        .toBe('function')

      // 偏好窄接口：只暴露语言设置读写，不暴露通用 invoke 或原始 IPC
      const exposedPreferencesKeys = await window.evaluate(() =>
        Object.keys(
          (globalThis as typeof globalThis & { api?: { preferences?: object } }).api?.preferences ??
            {}
        ).sort()
      )
      expect(exposedPreferencesKeys).toEqual([
        'getLanguageSettings',
        'setTargetLanguage',
        'setUiLanguage'
      ])

      const exposedApiKeys = await window.evaluate(() =>
        Object.keys((globalThis as typeof globalThis & { api?: object }).api ?? {}).sort()
      )
      expect(exposedApiKeys).toEqual(['conversation', 'models', 'preferences', 'usage'])

      // 用量窄接口：只暴露聚合读取，不暴露通用 invoke 或任意时间范围
      const exposedUsageKeys = await window.evaluate(() =>
        Object.keys(
          (globalThis as typeof globalThis & { api?: { usage?: object } }).api?.usage ?? {}
        ).sort()
      )
      expect(exposedUsageKeys).toEqual(['getOverview'])

      const conversationKeys = await window.evaluate(() =>
        Object.keys(
          (
            globalThis as typeof globalThis & {
              api: { conversation: object }
            }
          ).api.conversation
        ).sort()
      )
      expect(conversationKeys).toContain('runSkill')

      const settings = await window.evaluate(async () => {
        const preferences = (
          globalThis as typeof globalThis & {
            api: { preferences: { getLanguageSettings(): Promise<unknown> } }
          }
        ).api.preferences
        return preferences.getLanguageSettings()
      })
      expect(settings).toMatchObject({ status: 'ok' })
    } finally {
      await electronApp.close()
    }
  })
})
