import type { Page } from '@playwright/test'
import {
  expect,
  launchApp,
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

test('runs vocabulary inside the conversation, deduplicates, summarizes, and restores history', async () => {
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
        await expect(firstReply).toContainText(
          'Vocabulary result summary from the configured model.'
        )
        await expect(firstReply).toContainText('3 added')
        await expect(firstReply).toContainText('1 duplicate in this input')
        await expect(firstReply).toContainText('1 failed')
        expect(server.terms).toHaveLength(4)
        expect(server.summaries).toHaveLength(1)

        await submitVocabulary(window, 'apple, banana, orange, apple')
        const secondReply = window.locator('.message.assistant').last()
        await expect(secondReply).toContainText('0 added')
        await expect(secondReply).toContainText('3 existing')
        await expect(secondReply).toContainText('1 duplicate in this input')
        expect(server.terms).toHaveLength(4)
        expect(server.summaries).toHaveLength(2)

        await app.close()
        app = await launchApp(directory)
        window = await app.firstWindow()
        await waitForReady(window)
        await expect(window.locator('.message.user')).toHaveCount(2)
        await expect(window.locator('.message.assistant')).toHaveCount(2)
        await expect(window.locator('.message.assistant').last()).toContainText('0 added')
      } finally {
        await app.close()
      }
    })
  } finally {
    await server.close()
  }
})

test('keeps verified facts and offers description-only retry when the summary model fails', async () => {
  await withTempUserData(async (directory) => {
    await writeLocalePreference(directory, 'en')
    const app = await launchApp(directory)
    try {
      const window = await app.firstWindow()
      await waitForReady(window)
      await submitVocabulary(window, 'apple')

      const reply = window.locator('.message.assistant').last()
      await expect(reply).toContainText('Vocabulary processing completed')
      await expect(reply).toContainText('0 added')
      await expect(reply).toContainText('1 failed')
      await expect(window.getByRole('button', { name: 'Retry' })).toBeVisible()
    } finally {
      await app.close()
    }
  })
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
