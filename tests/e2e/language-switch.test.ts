import type { Page } from '@playwright/test'
import type { LingoMateApi } from '../../src/shared/conversation'
import {
  expect,
  launchApp,
  switchLanguage,
  test,
  waitForReady,
  withTempUserData,
  writeLocalePreference
} from './helpers'

async function readStoredPreference(window: Page): Promise<unknown> {
  return window.evaluate(async () => {
    const api = (globalThis as typeof globalThis & { api: LingoMateApi }).api.preferences
    const result = await api.getLocale()
    return result.status === 'ok' ? result.settings : result
  })
}

test('starts in the saved language, keeps user content across a restart and switching back', async () => {
  await withTempUserData(async (userDataPath) => {
    // 预写英文偏好：启动即为英文界面
    await writeLocalePreference(userDataPath, 'en')
    const firstLaunch = await launchApp(userDataPath)
    const window = await firstLaunch.firstWindow()
    await waitForReady(window)

    expect(await window.evaluate(() => document.documentElement.lang)).toBe('en')
    expect(await window.evaluate(() => document.documentElement.dir)).toBe('ltr')
    await expect(window.getByRole('heading', { level: 1 })).toHaveText(
      'Language Learning Companion'
    )

    // 英文界面完成一次发送，验证完整生成生命周期
    await window.fill('#message', 'Hello')
    await window.press('#message', 'Enter')
    await expect(window.locator('.status')).toHaveText('Reply complete', { timeout: 15_000 })
    const persisted = await window.evaluate(async () => {
      const api = (globalThis as typeof globalThis & { api: LingoMateApi }).api.conversation
      const listed = await api.list()
      if (listed.status === 'error') return null
      const loaded = await api.load({ sessionId: listed.conversations[0].sessionId })
      return loaded.status === 'ok' ? loaded.messages : null
    })
    expect(persisted).toHaveLength(2)

    await firstLaunch.close()

    // 重启后仍为英文，历史消息内容与 ID 不变
    const secondLaunch = await launchApp(userDataPath)
    const secondWindow = await secondLaunch.firstWindow()
    await waitForReady(secondWindow)
    expect(await secondWindow.evaluate(() => document.documentElement.lang)).toBe('en')
    await expect(secondWindow.locator('.message.user')).toContainText('Hello')
    const restored = await readStoredPreference(secondWindow)
    expect(restored).toEqual({ preference: 'en', resolvedLocale: 'en' })

    // 运行中切回中文：面板语言名称固定，draft 与历史保持
    await secondWindow.fill('#message', 'kept draft')
    await switchLanguage(secondWindow, '中文', 'zh-CN')
    await expect(secondWindow.locator('#message')).toHaveValue('kept draft')
    await expect(secondWindow.locator('.status')).toHaveText('准备就绪')
    await expect(secondWindow.locator('.message.user')).toContainText('Hello')
    expect(await readStoredPreference(secondWindow)).toEqual({
      preference: 'zh-CN',
      resolvedLocale: 'zh-CN'
    })

    await secondLaunch.close()

    // 中文偏好跨重启保持
    const thirdLaunch = await launchApp(userDataPath)
    const thirdWindow = await thirdLaunch.firstWindow()
    await waitForReady(thirdWindow)
    expect(await thirdWindow.evaluate(() => document.documentElement.lang)).toBe('zh-CN')
    await expect(thirdWindow.locator('.message.user')).toContainText('Hello')

    await thirdLaunch.close()
  })
})

test('follows the saved system preference and persists an explicit choice made at runtime', async () => {
  await withTempUserData(async (userDataPath) => {
    // 未保存偏好等同于 system：由 Main 按系统偏好顺序解析为受支持语言
    await writeLocalePreference(userDataPath, 'system')
    const app = await launchApp(userDataPath)
    const window = await app.firstWindow()
    await waitForReady(window)

    const initialLang = await window.evaluate(() => document.documentElement.lang)
    expect(['zh-CN', 'en']).toContain(initialLang)

    // 运行中选择英文并保存成功后界面切换，重启仍为英文
    await switchLanguage(window, 'English', 'en')
    await expect(window.getByRole('heading', { level: 1 })).toHaveText(
      'Language Learning Companion'
    )
    expect(await readStoredPreference(window)).toEqual({ preference: 'en', resolvedLocale: 'en' })

    await app.close()

    const relaunched = await launchApp(userDataPath)
    const relaunchWindow = await relaunched.firstWindow()
    await waitForReady(relaunchWindow)
    expect(await relaunchWindow.evaluate(() => document.documentElement.lang)).toBe('en')

    await relaunched.close()
  })
})

test('switching language during generation keeps the stream and canonical ids intact', async () => {
  await withTempUserData(async (userDataPath) => {
    await writeLocalePreference(userDataPath, 'zh-CN')
    const app = await launchApp(userDataPath)
    const window = await app.firstWindow()
    await waitForReady(window)

    await window.fill('#message', 'Hello')
    await window.press('#message', 'Enter')
    const draft = window.locator('.message.assistant')
    await draft.waitFor()
    const draftId = await draft.getAttribute('data-message-id')

    // 生成进行中打开设置页并切换语言：不取消生成、不重建投影
    await window.click('.settings-button')
    await window.getByRole('radio', { name: 'English' }).check()
    await window.waitForFunction(() => document.documentElement.lang === 'en', undefined, {
      timeout: 10_000
    })
    // 对话视图被设置页隐藏但保持挂载，生成仍在进行（Cancel 仍可用）
    const cancel = window.getByRole('button', { name: 'Cancel', includeHidden: true })
    await expect(cancel).toBeAttached()
    await window.click('.settings-back-button')

    await expect(window.locator('.status')).toHaveText('Reply complete', { timeout: 15_000 })
    expect(await window.locator('.message.assistant').getAttribute('data-message-id')).toBe(draftId)

    await app.close()
  })
})
