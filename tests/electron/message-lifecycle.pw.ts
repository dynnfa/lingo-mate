import { join } from 'node:path'
import type { Page } from '@playwright/test'
import type { ConversationMessage, LingoMateApi } from '../../src/shared/conversation'
import {
  expect,
  launchApp,
  test,
  waitForReady,
  withTempUserData,
  writeLocalePreference
} from './helpers'

async function loadMessages(window: Page, sessionId: string): Promise<ConversationMessage[]> {
  return window.evaluate(async (targetSessionId) => {
    const api = (globalThis as typeof globalThis & { api: LingoMateApi }).api.conversation
    const loaded = await api.load({ sessionId: targetSessionId })
    if (loaded.status === 'error') throw new Error(`load failed: ${loaded.error.code}`)
    return loaded.messages
  }, sessionId)
}

// 侧栏已改为按钮列表：通过 IPC 读取当前选中的会话，而不是不存在的 DOM 下拉框。
async function currentSessionId(window: Page): Promise<string> {
  return window.evaluate(async () => {
    const api = (globalThis as typeof globalThis & { api: LingoMateApi }).api.conversation
    const listed = await api.list()
    if (listed.status === 'error') throw new Error(`list failed: ${listed.error.code}`)
    return listed.conversations[0]?.sessionId ?? ''
  })
}

test('keeps one canonical assistant messageId from first render to persistence', async () => {
  await withTempUserData(async (userDataPath) => {
    await writeLocalePreference(userDataPath, 'zh-CN')
    const app = await launchApp(userDataPath)
    const window = await app.firstWindow()
    await waitForReady(window)

    await window.fill('#message', 'Hello')
    await window.press('#message', 'Enter')

    // draft 首次出现即携带 canonical messageId
    const draft = window.locator('.message.assistant')
    await draft.waitFor()
    const draftId = await draft.getAttribute('data-message-id')
    expect(draftId).toBeTruthy()

    await expect(window.locator('.status')).toHaveText('回复完成', { timeout: 15_000 })

    // completed 后同一条消息原位完成，不换 key、不产生重复
    await expect(window.locator('.message')).toHaveCount(2)
    const assistantId = await window.locator('.message.assistant').getAttribute('data-message-id')
    expect(assistantId).toBe(draftId)

    // UI 展示的身份与 SQLite 中的持久化身份一致
    const sessionId = await currentSessionId(window)
    const messages = await loadMessages(window, sessionId)
    expect(messages).toHaveLength(2)
    expect(messages[0]).toMatchObject({ role: 'user', content: 'Hello' })
    expect(messages[1]).toMatchObject({ role: 'assistant' })
    expect(messages[1].messageId).toBe(draftId)

    await app.close()
  })
})

test('cancel drops the partial draft and retry completes with a new assistant id', async () => {
  await withTempUserData(async (userDataPath) => {
    await writeLocalePreference(userDataPath, 'zh-CN')
    const app = await launchApp(userDataPath)
    const window = await app.firstWindow()
    await waitForReady(window)

    await window.fill('#message', 'Hello')
    await window.press('#message', 'Enter')

    const draft = window.locator('.message.assistant')
    await draft.waitFor()
    const cancelledDraftId = await draft.getAttribute('data-message-id')

    await window.click('button:has-text("取消")')
    await expect(window.locator('.status')).toHaveText('已取消，可重试。')
    await expect(window.locator('.message.assistant')).toHaveCount(0)
    await expect(window.locator('.message.user')).toHaveCount(1)

    // 数据库只留下 user 消息
    const sessionId = await currentSessionId(window)
    const afterCancel = await loadMessages(window, sessionId)
    expect(afterCancel).toHaveLength(1)
    expect(afterCancel[0]).toMatchObject({ role: 'user', content: 'Hello' })

    await window.click('button:has-text("重试")')
    await expect(window.locator('.status')).toHaveText('回复完成', { timeout: 15_000 })

    // 不重复 user；assistant 使用新的 canonical ID
    await expect(window.locator('.message.user')).toHaveCount(1)
    const retryAssistantId = await window
      .locator('.message.assistant')
      .getAttribute('data-message-id')
    expect(retryAssistantId).toBeTruthy()
    expect(retryAssistantId).not.toBe(cancelledDraftId)

    const afterRetry = await loadMessages(window, sessionId)
    expect(afterRetry).toHaveLength(2)
    expect(afterRetry[1].messageId).toBe(retryAssistantId)

    await app.close()
  })
})

test('destroying the sender cancels its request and relaunch offers retry', async () => {
  await withTempUserData(async (userDataPath) => {
    await writeLocalePreference(userDataPath, 'zh-CN')
    const firstLaunch = await launchApp(userDataPath)
    const firstWindow = await firstLaunch.firstWindow()
    await waitForReady(firstWindow)

    await firstWindow.fill('#message', 'Hello')
    await firstWindow.press('#message', 'Enter')
    // 流式生成中销毁窗口（sender），请求应被取消且不持久化 assistant 草稿
    await firstWindow.locator('.message.assistant').waitFor()
    await firstLaunch.close()

    const secondLaunch = await launchApp(userDataPath)
    const secondWindow = await secondLaunch.firstWindow()
    await waitForReady(secondWindow)

    // 恢复后最后一条未回答的 user 消息可重试
    await expect(secondWindow.locator('.message.user')).toContainText('Hello')
    await expect(secondWindow.locator('button:has-text("重试")')).toHaveCount(1)

    await secondWindow.click('button:has-text("重试")')
    await expect(secondWindow.locator('.status')).toHaveText('回复完成', { timeout: 15_000 })

    await secondLaunch.close()
  })
})

test('rejects a cancel from a window that does not own the request', async () => {
  await withTempUserData(async (userDataPath) => {
    await writeLocalePreference(userDataPath, 'zh-CN')
    const app = await launchApp(userDataPath)
    const firstWindow = await app.firstWindow()
    await waitForReady(firstWindow)

    // 同一应用再开一个窗口，验证 sender 所有权（electron 模块作为参数传入 evaluate）
    const secondWindowId = await app.evaluate(
      ({ BrowserWindow }, { preloadPath, url }) => {
        const second = new BrowserWindow({
          width: 400,
          height: 300,
          show: false,
          webPreferences: {
            preload: preloadPath,
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true
          }
        })
        void second.loadURL(url)
        return second.id
      },
      {
        preloadPath: join(process.cwd(), 'out', 'preload', 'index.js'),
        url: firstWindow.url()
      }
    )
    expect(secondWindowId).toBeTruthy()

    await expect
      .poll(async () => app.windows().length, { timeout: 10_000 })
      .toBeGreaterThanOrEqual(2)
    const foreignWindow = app.windows().find((candidate) => candidate !== firstWindow)!
    await foreignWindow.waitForFunction(() => {
      const api = (globalThis as typeof globalThis & { api?: LingoMateApi }).api
      return typeof api?.conversation?.cancel === 'function'
    })

    const startedRequestId = firstWindow.evaluate(() => {
      return new Promise<string>((resolve) => {
        const api = (globalThis as typeof globalThis & { api: LingoMateApi }).api.conversation
        const unsubscribe = api.onEvent((event) => {
          if (event.type === 'started') {
            unsubscribe()
            resolve(event.requestId)
          }
        })
      })
    })

    await firstWindow.fill('#message', 'Hello')
    await firstWindow.press('#message', 'Enter')
    const requestId = await startedRequestId

    // 非创建请求的窗口不能取消：安全类型化错误，且不影响原生成
    const foreignCancel = await foreignWindow.evaluate(async (targetRequestId) => {
      const api = (globalThis as typeof globalThis & { api: LingoMateApi }).api.conversation
      return api.cancel({ requestId: targetRequestId })
    }, requestId)

    expect(foreignCancel).toEqual({
      status: 'error',
      error: { code: 'REQUEST_NOT_FOUND' }
    })

    await expect(firstWindow.locator('.status')).toHaveText('回复完成', { timeout: 15_000 })
    await expect(firstWindow.locator('.message.assistant')).toHaveCount(1)

    await app.close()
  })
})
