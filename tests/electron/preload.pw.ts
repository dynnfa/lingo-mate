import { expect, launchApp, test, withTempUserData } from './helpers'

test('exposes the conversation and preferences interfaces from the sandboxed preload', async () => {
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

      // 偏好窄接口：只暴露 getLocale/setLocale，不暴露通用 invoke 或原始 IPC
      const exposedPreferencesKeys = await window.evaluate(() =>
        Object.keys(
          (globalThis as typeof globalThis & { api?: { preferences?: object } }).api?.preferences ??
            {}
        ).sort()
      )
      expect(exposedPreferencesKeys).toEqual(['getLocale', 'setLocale'])

      const locale = await window.evaluate(async () => {
        const preferences = (
          globalThis as typeof globalThis & {
            api: { preferences: { getLocale(): Promise<unknown> } }
          }
        ).api.preferences
        return preferences.getLocale()
      })
      expect(locale).toMatchObject({ status: 'ok' })
    } finally {
      await electronApp.close()
    }
  })
})
