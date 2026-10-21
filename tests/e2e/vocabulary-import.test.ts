import type { Page } from '@playwright/test'
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
import { startVocabularyServer } from '../integration/fixtures/vocabulary-server'
import type { LingoMateApi } from '../../src/shared/conversation'

async function selectVocabulary(window: Page): Promise<void> {
  const input = window.locator('#message')
  await input.fill('/vocabulary')
  await input.press('Enter')
  await expect(input).toHaveValue('/vocabulary ')
  await expect(window.getByRole('region', { name: 'Conversation history' })).toBeVisible()
}

async function submitVocabulary(window: Page, text: string): Promise<void> {
  await selectVocabulary(window)
  await window.locator('#message').fill(`/vocabulary ${text}`)
  await window.locator('#message').press('Enter')
}

test('runs vocabulary inside the conversation, executes tool-call inserts, reports local facts, and restores history', async () => {
  const server = await startVocabularyServer()
  try {
    await withTempUserData(async (directory) => {
      await writeLocalePreference(directory, 'en')
      await writeModelsConfig(directory, server.baseUrl, 'test-model')
      let app = await launchApp(directory)
      try {
        let window = await app.firstWindow()
        await waitForReady(window)

        const conversationKeys = await window.evaluate(() =>
          Object.keys(
            (globalThis as typeof globalThis & { api: LingoMateApi }).api.conversation
          ).sort()
        )
        expect(conversationKeys).toEqual([
          'cancel',
          'create',
          'list',
          'load',
          'onEvent',
          'retry',
          'runSkill',
          'send'
        ])
        await submitVocabulary(window, 'apple, banana, orange, apple, bad')
        await expect(window.locator('.message.user').last()).toContainText(
          '/vocabulary apple, banana, orange, apple, bad'
        )
        const firstReply = window.locator('.message.assistant').last()
        await expect(firstReply).toContainText('Processed 5 terms')
        await expect(firstReply).toContainText('3 added')
        await expect(firstReply).toContainText('apple, banana, and orange')
        await expect(firstReply).toContainText('1 repeated in this input')
        await expect(firstReply).toContainText('1 failed (bad)')
        expect(server.terms).toHaveLength(4)

        await submitVocabulary(window, 'apple, banana, orange, apple')
        // 反馈省略空分组：零新增时只列出已有与重复项
        const secondReply = window.locator('.message.assistant').last()
        await expect(secondReply).toContainText('Processed 4 terms')
        await expect(secondReply).toContainText('3 already saved')
        await expect(secondReply).toContainText('1 repeated in this input')
        // 已有词零模型调用：请求仍停留在第一次提交的四个词。
        expect(server.terms).toHaveLength(4)

        await app.close()
        app = await launchApp(directory)
        window = await app.firstWindow()
        await waitForReady(window)
        // 启动打开空白草稿；经侧栏打开原会话后历史完整恢复
        await openLatestConversation(window)
        await expect(window.locator('.message.user')).toHaveCount(2)
        await expect(window.locator('.message.assistant')).toHaveCount(2)
        await expect(window.locator('.message.assistant').last()).toContainText('3 already saved')
      } finally {
        await app.close()
      }
    })
  } finally {
    await server.close()
  }
})

test('reports failed items locally when no model is configured, without a second request', async () => {
  await withTempUserData(async (directory) => {
    await writeLocalePreference(directory, 'en')
    const app = await launchApp(directory)
    try {
      const window = await app.firstWindow()
      await waitForReady(window)
      await submitVocabulary(window, 'apple')

      const reply = window.locator('.message.assistant').last()
      await expect(reply).toContainText('Processed 1 terms')
      await expect(reply).toContainText('1 failed (apple)')
      // 报告已提交，不再提供仅重试描述的入口。
      await expect(window.getByRole('button', { name: 'Retry' })).toHaveCount(0)
    } finally {
      await app.close()
    }
  })
})

test('reports an unsupported tool capability as a retryable conversation error', async () => {
  const server = await startVocabularyServer()
  try {
    await withTempUserData(async (directory) => {
      await writeLocalePreference(directory, 'en')
      await writeModelsConfig(directory, server.baseUrl, 'test-model')
      const app = await launchApp(directory)
      try {
        const window = await app.firstWindow()
        await waitForReady(window)
        await submitVocabulary(window, 'unsupported')

        await expect(
          window.getByText(
            "The current model or endpoint doesn't support the tool calls required to save vocabulary. Switch models or endpoints and try again."
          )
        ).toBeVisible()
        await expect(window.locator('.message.assistant')).toHaveCount(0)
        await expect(window.getByRole('button', { name: 'Retry' })).toBeVisible()
        expect(server.terms).toEqual(['unsupported'])
      } finally {
        await app.close()
      }
    })
  } finally {
    await server.close()
  }
})

test('cancels analysis before commit and keeps the conversation input usable', async () => {
  const server = await startVocabularyServer()
  try {
    await withTempUserData(async (directory) => {
      await writeLocalePreference(directory, 'en')
      await writeModelsConfig(directory, server.baseUrl, 'test-model')
      const app = await launchApp(directory)
      try {
        const window = await app.firstWindow()
        await waitForReady(window)
        await submitVocabulary(window, 'slow, orange')
        await expect.poll(() => server.terms.includes('slow')).toBe(true)
        await window.getByRole('button', { name: 'Cancel' }).click()
        await expect(window.getByText('Cancelled. You can retry.')).toBeVisible()
        await expect(window.locator('#message')).toBeEnabled()
        await expect(window.locator('.message.assistant')).toHaveCount(0)

        await submitVocabulary(window, 'orange')
        await expect(window.locator('.message.assistant').last()).toContainText('1 added')
      } finally {
        await app.close()
      }
    })
  } finally {
    await server.close()
  }
})

test('frozen LangGraph processes 20 words and discards cancelled analysis before an explicit retry', async () => {
  test.setTimeout(90_000)
  const server = await startVocabularyServer()
  try {
    await withTempUserData(async (directory) => {
      await writeLocalePreference(directory, 'en')
      await writeModelsConfig(directory, server.baseUrl, 'test-model')
      const app = await launchApp(directory, { agentBundle: true })
      try {
        const window = await app.firstWindow()
        await waitForReady(window)
        const terms = Array.from({ length: 20 }, (_, i) => `word${i}`)
        await submitVocabulary(window, terms.join(','))
        await expect(window.locator('.message.assistant').last()).toContainText('20 added', {
          timeout: 40_000
        })
        expect(server.terms.slice().sort()).toEqual(terms.slice().sort())
        const countEntries = (): Promise<number> =>
          window.evaluate(async () => {
            const result = await (
              globalThis as typeof globalThis & { api: LingoMateApi }
            ).api.vocabulary.list({})
            if (result.status !== 'ok') throw new Error('Vocabulary list failed')
            return result.entries.length
          })
        expect(await countEntries()).toBe(20)
        await submitVocabulary(window, 'slow,orange')
        await expect.poll(() => server.terms.includes('slow')).toBe(true)
        await window.getByRole('button', { name: 'Cancel', exact: true }).click()
        await expect(window.getByText('Cancelled. You can retry.')).toBeVisible()
        expect(await countEntries()).toBe(20)
        await window.getByRole('button', { name: 'Retry', exact: true }).click()
        await expect(window.locator('.message.assistant').last()).toContainText('2 added', {
          timeout: 15_000
        })
        expect(await countEntries()).toBe(22)
      } finally {
        await app.close()
      }
    })
  } finally {
    await server.close()
  }
})
