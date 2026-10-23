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
import { startExploreVocabularyServer } from '../integration/fixtures/explore-vocabulary-server'

// /explore-vocabulary 全链路实窗验收：Renderer 输入 → Preload → Main → Core →
// Python / LangGraph → 工具调用 → JSON 历史文件 → Markdown 会话表格，以及重启后的历史恢复。
test('runs /explore-vocabulary end to end and restores the table after restart', async () => {
  test.setTimeout(60_000)
  const server = await startExploreVocabularyServer()
  try {
    await withTempUserData(async (directory) => {
      await writeLocalePreference(directory, 'zh-CN')
      await writeModelsConfig(directory, server.baseUrl, 'test-model')
      let app = await launchApp(directory, { agentBundle: true })
      try {
        let window = await app.firstWindow()
        await waitForReady(window)

        // 直接输入完整命令（含末尾空格）即可发送，不经过选择器。
        const input = window.locator('#message')
        await input.fill('/explore-vocabulary ')
        await input.press('Enter')
        await expect(window.locator('.status')).toHaveText('回复完成', { timeout: 40_000 })

        // 用户消息就是命令本身（角色标签“你”独立于正文）。
        await expect(window.locator('.message.user').last()).toContainText('/explore-vocabulary')
        const reply = window.locator('.message.assistant').last()
        await expect(reply.locator('thead th')).toHaveCount(4)
        await expect(reply.locator('thead th').first()).toHaveText('序号')
        await expect(reply.locator('thead th').nth(1)).toHaveText('单词')
        await expect(reply.locator('tbody tr')).toHaveCount(10)
        await expect(reply.locator('tbody tr').first()).toContainText('eeworda')

        // 首次请求携带 count=10 与空禁用列表。
        const firstRequest = JSON.parse(
          server.requests[0].messages.find((message) => message.role === 'user')?.content ?? '{}'
        ) as { count: number; excludedTerms: string[] }
        expect(firstRequest.count).toBe(10)
        expect(firstRequest.excludedTerms).toEqual([])

        // 第二次探索：请求收到上一批全部单词作为禁用列表。
        await input.fill('/explore-vocabulary')
        await input.press('Enter')
        await expect(window.locator('.status')).toHaveText('回复完成', { timeout: 40_000 })
        const secondReply = window.locator('.message.assistant').last()
        await expect(secondReply.locator('tbody tr')).toHaveCount(10)
        await expect(secondReply).toContainText('eewordk')
        const secondRequest = JSON.parse(
          server.requests[1].messages.find((message) => message.role === 'user')?.content ?? '{}'
        ) as { count: number; excludedTerms: string[] }
        expect(secondRequest.excludedTerms).toEqual(expect.arrayContaining(['eeworda', 'eewordj']))

        // 结果保存在 userData 的 JSON 历史文件，不写数据库技能报告。
        const history = JSON.parse(
          await readFile(join(directory, 'explore-vocabulary-history.json'), 'utf8')
        ) as {
          schemaVersion: number
          batches: Array<{ items: Array<{ term: string; normalizedTerm: string }> }>
        }
        expect(history.schemaVersion).toBe(1)
        expect(history.batches).toHaveLength(2)
        expect(history.batches[0].items).toHaveLength(10)
        expect(history.batches[0].items[0].normalizedTerm).toBe('eeworda')

        // 词汇历史独立于短语历史：短语文件不存在。
        await expect(
          readFile(join(directory, 'explore-phrase-history.json'), 'utf8')
        ).rejects.toMatchObject({ code: 'ENOENT' })

        // 重启后从会话历史恢复同一表格。
        await app.close()
        app = await launchApp(directory, { agentBundle: true })
        window = await app.firstWindow()
        await waitForReady(window)
        await openLatestConversation(window)
        const restored = window.locator('.message.assistant').last()
        await expect(restored.locator('tbody tr')).toHaveCount(10)
        await expect(restored).toContainText('eewordk')
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

for (const locale of ['zh-CN', 'en'] as const) {
  test(`bundled exploration tops up candidates with ${locale} explanations`, async () => {
    test.setTimeout(60_000)
    const server = await startExploreVocabularyServer({ firstCount: 4 })
    try {
      await withTempUserData(async (directory) => {
        await writeLocalePreference(directory, locale)
        await writeModelsConfig(directory, server.baseUrl, 'test-model')
        const app = await launchApp(directory, { agentBundle: true })
        try {
          const window = await app.firstWindow()
          await waitForReady(window)
          await window.locator('#message').fill('/explore-vocabulary')
          await window.locator('#message').press('Enter')
          await expect(window.locator('.status')).toHaveText(
            locale === 'en' ? 'Reply complete' : '回复完成',
            { timeout: 40_000 }
          )
          await expect(window.locator('.message.assistant').last().locator('tbody tr')).toHaveCount(
            10
          )
          expect(server.requests).toHaveLength(2)
          const data = server.requests.map((request) => JSON.parse(request.messages[1].content))
          expect(data.map((request) => request.count)).toEqual([10, 6])
          expect(data[1].excludedTerms).toHaveLength(4)
          for (const request of server.requests) {
            expect(request.messages[0].content).toContain(
              locale === 'en' ? 'English (en)' : 'Simplified Chinese (zh-CN)'
            )
            expect(request.messages[0].content).toContain('term and example are written in English')
          }
        } finally {
          await app.close()
        }
      })
    } finally {
      await server.close()
    }
  })
}

test('bundled exploration cancels without writing history and allows explicit retry', async () => {
  test.setTimeout(60_000)
  const server = await startExploreVocabularyServer({ hangAtRequest: 1 })
  try {
    await withTempUserData(async (directory) => {
      await writeLocalePreference(directory, 'en')
      await writeModelsConfig(directory, server.baseUrl, 'test-model')
      const app = await launchApp(directory, { agentBundle: true })
      try {
        const window = await app.firstWindow()
        await waitForReady(window)
        await window.locator('#message').fill('/explore-vocabulary')
        await window.locator('#message').press('Enter')
        await expect.poll(() => server.requests.length, { timeout: 40_000 }).toBe(1)
        await window.getByRole('button', { name: 'Cancel', exact: true }).click()
        await expect(window.getByRole('button', { name: 'Retry', exact: true })).toBeVisible()
        await expect(
          readFile(join(directory, 'explore-vocabulary-history.json'))
        ).rejects.toMatchObject({ code: 'ENOENT' })
        await window.getByRole('button', { name: 'Retry', exact: true }).click()
        await expect(window.locator('.status')).toHaveText('Reply complete', { timeout: 40_000 })
        await expect(window.locator('.message.assistant').last().locator('tbody tr')).toHaveCount(
          10
        )
        expect(server.requests).toHaveLength(2)
      } finally {
        await app.close()
      }
    })
  } finally {
    await server.close()
  }
})
