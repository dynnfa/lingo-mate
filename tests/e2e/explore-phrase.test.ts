import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  expect,
  launchApp,
  openLatestConversation,
  test,
  waitForReady,
  withTempUserData,
  writeLocalePreference,
  writeModelsConfig
} from './helpers'
import { startExplorePhraseServer } from '../integration/fixtures/explore-phrase-server'

// /explore-phrase 全链路实窗验收：Renderer 输入 → Preload → Main → Core →
// 工具调用 → JSON 历史文件 → Markdown 会话表格，以及重启后的历史恢复。
test('runs /explore-phrase end to end and restores the table after restart', async () => {
  const server = await startExplorePhraseServer()
  try {
    await withTempUserData(async (directory) => {
      await writeLocalePreference(directory, 'zh-CN')
      await writeModelsConfig(directory, server.baseUrl, 'test-model')
      let app = await launchApp(directory)
      try {
        let window = await app.firstWindow()
        await waitForReady(window)

        // 直接输入完整命令（含末尾空格）即可发送，不经过选择器。
        const input = window.locator('#message')
        await input.fill('/explore-phrase ')
        await input.press('Enter')

        // 用户消息就是命令本身（角色标签“你”独立于正文）。
        await expect(window.locator('.message.user').last()).toContainText('/explore-phrase')
        const reply = window.locator('.message.assistant').last()
        await expect(reply.locator('thead th')).toHaveCount(4)
        await expect(reply.locator('thead th').first()).toHaveText('序号')
        await expect(reply.locator('thead th').nth(1)).toHaveText('短语')
        await expect(reply.locator('tbody tr')).toHaveCount(10)
        await expect(reply.locator('tbody tr').first()).toContainText('e2e phrase 1')

        // 首次请求携带 count=10 与空禁用列表。
        const firstRequest = JSON.parse(
          server.requests[0].messages.find((message) => message.role === 'user')?.content ?? '{}'
        ) as { count: number; excludedPhrases: string[] }
        expect(firstRequest.count).toBe(10)
        expect(firstRequest.excludedPhrases).toEqual([])

        // 第二次探索：请求收到上一批全部短语作为禁用列表。
        await input.fill('/explore-phrase')
        await input.press('Enter')
        const secondReply = window.locator('.message.assistant').last()
        await expect(secondReply.locator('tbody tr')).toHaveCount(10)
        await expect(secondReply).toContainText('e2e phrase 11')
        const secondRequest = JSON.parse(
          server.requests[1].messages.find((message) => message.role === 'user')?.content ?? '{}'
        ) as { count: number; excludedPhrases: string[] }
        expect(secondRequest.excludedPhrases).toEqual(
          expect.arrayContaining(['e2e phrase 1', 'e2e phrase 10'])
        )

        // 结果保存在 userData 的 JSON 历史文件，不写数据库技能报告。
        const history = JSON.parse(
          await readFile(join(directory, 'explore-phrase-history.json'), 'utf8')
        ) as {
          schemaVersion: number
          batches: Array<{ items: Array<{ phrase: string; normalizedPhrase: string }> }>
        }
        expect(history.schemaVersion).toBe(1)
        expect(history.batches).toHaveLength(2)
        expect(history.batches[0].items).toHaveLength(10)
        expect(history.batches[0].items[0].normalizedPhrase).toBe('e2e phrase 1')

        // 重启后从会话历史恢复同一表格。
        await app.close()
        app = await launchApp(directory)
        window = await app.firstWindow()
        await waitForReady(window)
        await openLatestConversation(window)
        const restored = window.locator('.message.assistant').last()
        await expect(restored.locator('tbody tr')).toHaveCount(10)
        await expect(restored).toContainText('e2e phrase 11')
        // 重启恢复不触发新的模型请求。
        expect(server.requests).toHaveLength(2)
      } finally {
        await app.close()
      }
    })
  } finally {
    await server.close()
  }
})
