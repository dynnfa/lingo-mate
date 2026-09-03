import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test'
import type { LingoMateApi } from '../../src/shared/conversation'

async function launchApp(userDataPath: string): Promise<ElectronApplication> {
  return electron.launch({ args: [process.cwd(), `--user-data-dir=${userDataPath}`] })
}

async function withTempUserData(run: (userDataPath: string) => Promise<void>): Promise<void> {
  const userDataPath = await mkdtemp(join(tmpdir(), 'lingo-mate-recovery-'))
  try {
    await run(userDataPath)
  } finally {
    await rm(userDataPath, { force: true, recursive: true })
  }
}

test('restores the same conversation and history after relaunch', async () => {
  await withTempUserData(async (userDataPath) => {
    const firstLaunch = await launchApp(userDataPath)
    const firstWindow = await firstLaunch.firstWindow()

    // 等待 Renderer 完成启动恢复（空库自动创建会话）
    await firstWindow.waitForSelector('main[data-phase="ready"]')

    // 通过 UI 发送一条消息，等待本地模型完成生成（completed 事件将状态置为"回复完成"）
    await firstWindow.fill('#message', 'Hello')
    await expect(firstWindow.locator('#message')).toHaveValue('Hello')
    await firstWindow.press('#message', 'Enter')
    await expect(firstWindow.locator('.message.user')).toContainText('Hello')
    await expect(firstWindow.locator('.status')).toHaveText('回复完成')
    await expect(firstWindow.locator('.message.assistant')).toContainText('收到')

    const sessionId = await firstWindow.evaluate(async () => {
      const api = (globalThis as typeof globalThis & { api: LingoMateApi }).api.conversation
      const listed = await api.list()
      return listed.status === 'ok' ? listed.conversations[0]?.sessionId : undefined
    })
    expect(sessionId).toBeTruthy()

    await firstLaunch.close()

    const secondLaunch = await launchApp(userDataPath)
    const secondWindow = await secondLaunch.firstWindow()

    const restored = await secondWindow.evaluate(
      async ({ sessionId }) => {
        const api = (globalThis as typeof globalThis & { api: LingoMateApi }).api.conversation
        const listed = await api.list()
        const loaded = await api.load({ sessionId })
        return { listed, loaded }
      },
      { sessionId }
    )

    expect(restored.listed.status).toBe('ok')
    if (restored.listed.status === 'ok') {
      expect(restored.listed.conversations[0].sessionId).toBe(sessionId)
    }
    expect(restored.loaded.status).toBe('ok')
    if (restored.loaded.status === 'ok') {
      expect(restored.loaded.messages).toHaveLength(2)
      expect(restored.loaded.messages[0]).toMatchObject({ role: 'user', content: 'Hello' })
      expect(restored.loaded.messages[1]).toMatchObject({ role: 'assistant' })
    }

    // Renderer 自身的恢复投影也应显示历史
    await expect(secondWindow.locator('.message.user')).toContainText('Hello')

    await secondLaunch.close()
  })
})

test('returns safe structured errors for malformed and unknown sessions', async () => {
  await withTempUserData(async (userDataPath) => {
    const app = await launchApp(userDataPath)
    const window = await app.firstWindow()

    const malformed = await window.evaluate(async () => {
      const api = (globalThis as typeof globalThis & { api: LingoMateApi }).api.conversation
      try {
        await api.load({ sessionId: 'not-a-uuid' })
        return { kind: 'resolved' as const }
      } catch (error) {
        return { kind: 'rejected' as const, message: String(error) }
      }
    })

    // preload 的 Zod 校验直接拒绝畸形输入
    expect(malformed.kind).toBe('rejected')
    if (malformed.kind === 'rejected') {
      expect(malformed.message).not.toContain('sqlite')
      expect(malformed.message).not.toContain('userData')
    }

    const missing = await window.evaluate(async () => {
      const api = (globalThis as typeof globalThis & { api: LingoMateApi }).api.conversation
      return api.load({ sessionId: '00000000-0000-4000-8000-000000000000' })
    })

    // 不存在的会话返回类型化 NOT_FOUND，不携带内部细节
    expect(missing).toEqual({
      status: 'error',
      error: { code: 'NOT_FOUND', message: '会话不存在或已被删除。' }
    })

    await app.close()
  })
})
