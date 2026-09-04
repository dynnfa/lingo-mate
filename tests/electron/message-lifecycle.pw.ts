import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page
} from '@playwright/test'
import type { LingoMateApi } from '../../src/shared/conversation'

async function launchApp(userDataPath: string): Promise<ElectronApplication> {
  return electron.launch({ args: [process.cwd(), `--user-data-dir=${userDataPath}`] })
}

async function withTempUserData(run: (userDataPath: string) => Promise<void>): Promise<void> {
  const userDataPath = await mkdtemp(join(tmpdir(), 'lingo-mate-lifecycle-'))
  try {
    await run(userDataPath)
  } finally {
    await rm(userDataPath, { force: true, recursive: true })
  }
}

async function waitForReady(window: Page): Promise<void> {
  await window.waitForSelector('main[data-phase="ready"]')
}

async function loadMessages(
  window: Page,
  sessionId: string
): Promise<import('../../src/shared/conversation').ConversationMessage[]> {
  return window.evaluate(async (targetSessionId) => {
    const api = (globalThis as typeof globalThis & { api: LingoMateApi }).api.conversation
    const loaded = await api.load({ sessionId: targetSessionId })
    if (loaded.status === 'error') throw new Error(`load failed: ${loaded.error.code}`)
    return loaded.messages
  }, sessionId)
}

async function currentSessionId(window: Page): Promise<string> {
  return window.evaluate(() => {
    return document.querySelector<HTMLSelectElement>('#conversation')?.value ?? ''
  })
}

test('keeps one canonical assistant messageId from first render to persistence', async () => {
  await withTempUserData(async (userDataPath) => {
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

    // 重启后只恢复持久消息：一条 user，且被投影为可重试，不会永久 generating
    await expect(secondWindow.locator('.message.user')).toHaveCount(1)
    await expect(secondWindow.locator('.message.assistant')).toHaveCount(0)
    await expect(secondWindow.locator('.message.user button:has-text("重试")')).toHaveCount(1)

    // 重试成功后补齐 assistant 回复
    await secondWindow.click('button:has-text("重试")')
    await expect(secondWindow.locator('.status')).toHaveText('回复完成', { timeout: 15_000 })
    await expect(secondWindow.locator('.message.user')).toHaveCount(1)
    await expect(secondWindow.locator('.message.assistant')).toHaveCount(1)

    await secondLaunch.close()
  })
})

test('only the owning sender can cancel an active request', async () => {
  await withTempUserData(async (userDataPath) => {
    const app = await launchApp(userDataPath)
    const firstWindow = await app.firstWindow()
    await waitForReady(firstWindow)

    // 先建第二个窗口（同一 preload），再开始生成，避免和流式时长赛跑
    await app.evaluate(
      ({ BrowserWindow }, { preloadPath, url }) => {
        const second = new BrowserWindow({
          show: false,
          webPreferences: {
            preload: preloadPath,
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true
          }
        })
        void second.loadURL(url)
      },
      {
        preloadPath: join(process.cwd(), 'out', 'preload', 'index.js'),
        url: firstWindow.url()
      }
    )

    await expect
      .poll(async () => app.windows().filter((candidate) => candidate !== firstWindow).length, {
        timeout: 10_000
      })
      .toBe(1)
    const secondWindow = app.windows().find((candidate) => candidate !== firstWindow)!
    await secondWindow.waitForFunction(() => {
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
    const foreignCancel = await secondWindow.evaluate(async (targetRequestId) => {
      const api = (globalThis as typeof globalThis & { api: LingoMateApi }).api.conversation
      return api.cancel({ requestId: targetRequestId })
    }, requestId)

    expect(foreignCancel).toEqual({
      status: 'error',
      error: { code: 'REQUEST_NOT_FOUND', message: '没有找到可取消的回复请求。' }
    })

    await expect(firstWindow.locator('.status')).toHaveText('回复完成', { timeout: 15_000 })
    await expect(firstWindow.locator('.message.assistant')).toHaveCount(1)

    await app.close()
  })
})
