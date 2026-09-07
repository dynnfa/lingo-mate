import type { Page } from '@playwright/test'
import {
  expect,
  launchApp,
  test,
  waitForReady,
  withTempUserData,
  writeLocalePreference,
  writeModelsConfig,
  switchLanguage
} from './helpers'
import { startVocabularyServer } from '../integration/fixtures/vocabulary-server'
import type { LingoMateApi } from '../../src/shared/conversation'

async function enterVocabulary(window: Page): Promise<void> {
  await window.locator('#message').fill('/vocabulary')
  await window.locator('#message').press('Enter')
  await expect(window.locator('#vocabulary-input')).toBeFocused()
}

test('imports, deduplicates, shows meanings and pronunciation, and persists across app restart', async () => {
  const server = await startVocabularyServer()
  try {
    await withTempUserData(async (directory) => {
      await writeLocalePreference(directory, 'en')
      await writeModelsConfig(directory, server.baseUrl, 'test-model')
      let app = await launchApp(directory)
      try {
        let window = await app.firstWindow()
        await waitForReady(window)
        const apiKeys = await window.evaluate(() =>
          Object.keys(
            (globalThis as typeof globalThis & { api: LingoMateApi }).api.vocabulary
          ).sort()
        )
        expect(apiKeys).toEqual(['addBatch', 'cancelBatch', 'list'])
        await enterVocabulary(window)
        await window.locator('#vocabulary-input').fill('apple, banana, orange, apple, bad')
        await window.getByRole('button', { name: 'Analyze and save' }).click()
        const results = window.getByRole('region', { name: 'Batch results' })
        await expect(results).toContainText('3 saved')
        await expect(results).toContainText('Same as entry 1')
        await expect(window.locator('.vocabulary-entry')).toHaveCount(3)
        const apple = window
          .locator('.vocabulary-entry')
          .filter({ has: window.getByRole('heading', { name: 'apple', exact: true }) })
        await expect(apple).toContainText('/ˈæpəl/')
        await expect(apple).toContainText('Follow the stress mark')
        await expect(window.locator('.message')).toHaveCount(0)
        expect(server.terms).toHaveLength(4)
        await window.locator('#vocabulary-input').fill('apple, banana, orange')
        await window.getByRole('button', { name: 'Analyze and save' }).click()
        await expect(results).toContainText('3 existing')
        expect(server.terms).toHaveLength(4)
        await switchLanguage(window, '中文', 'zh-CN')
        await expect(window.locator('.vocabulary-entry')).toHaveCount(3)
        expect(server.terms).toHaveLength(4)
        await window.screenshot({ path: test.info().outputPath('vocabulary.png') })
        await window.locator('.vocabulary-entry').first().scrollIntoViewIfNeeded()
        await window.screenshot({ path: test.info().outputPath('vocabulary-list.png') })
        await app.close()
        app = await launchApp(directory)
        window = await app.firstWindow()
        await waitForReady(window)
        await enterVocabulary(window)
        await expect(window.locator('.vocabulary-entry')).toHaveCount(3)
        const entries = await window.evaluate(() =>
          (globalThis as typeof globalThis & { api: LingoMateApi }).api.vocabulary.list({})
        )
        expect(entries.status).toBe('ok')
        if (entries.status === 'ok')
          expect(entries.entries.every((entry) => entry.explanationLanguage === 'en')).toBe(true)
      } finally {
        await app.close()
      }
    })
  } finally {
    await server.close()
  }
})

test('missing config and cancellation produce no saved entries and leave input usable', async () => {
  const server = await startVocabularyServer()
  try {
    await withTempUserData(async (directory) => {
      await writeLocalePreference(directory, 'en')
      const app = await launchApp(directory)
      try {
        const window = await app.firstWindow()
        await waitForReady(window)
        await enterVocabulary(window)
        await window.locator('#vocabulary-input').fill('apple')
        await window.getByRole('button', { name: 'Analyze and save' }).click()
        await expect(window.getByRole('region', { name: 'Batch results' })).toContainText(
          'Configure a real model'
        )
        await expect(window.locator('.vocabulary-entry')).toHaveCount(0)
        await window.evaluate(async (baseUrl) => {
          const api = (globalThis as typeof globalThis & { api: LingoMateApi }).api
          await api.models.saveSettings({
            protocol: 'openai-compatible',
            baseUrl,
            modelId: 'test-model',
            credential: { action: 'remove' }
          })
        }, server.baseUrl)
        await window.locator('#vocabulary-input').fill('slow,orange')
        await window.getByRole('button', { name: 'Analyze and save' }).click()
        await expect(window.locator('#vocabulary-input')).toBeDisabled()
        await window.getByRole('button', { name: 'Cancel batch' }).click()
        await expect(window.getByRole('region', { name: 'Batch results' })).toContainText(
          'Batch cancelled'
        )
        await expect(window.locator('#vocabulary-input')).toHaveValue('slow,orange')
        await expect(window.locator('#vocabulary-input')).toBeEnabled()
        await expect(window.locator('.vocabulary-entry')).toHaveCount(0)
      } finally {
        await app.close()
      }
    })
  } finally {
    await server.close()
  }
})

test('closing the window during analysis cancels the batch before a restart', async () => {
  const server = await startVocabularyServer()
  try {
    await withTempUserData(async (directory) => {
      await writeLocalePreference(directory, 'en')
      await writeModelsConfig(directory, server.baseUrl, 'test-model')
      let app = await launchApp(directory)
      try {
        let window = await app.firstWindow()
        await waitForReady(window)
        await enterVocabulary(window)
        await window.locator('#vocabulary-input').fill('slow,orange')
        await window.getByRole('button', { name: 'Analyze and save' }).click()
        await expect.poll(() => server.terms.includes('slow')).toBe(true)
        await window.close()
        await app.close()
        app = await launchApp(directory)
        window = await app.firstWindow()
        await waitForReady(window)
        await enterVocabulary(window)
        await expect(window.getByText('No vocabulary saved yet.')).toBeVisible()
        const listed = await window.evaluate(() =>
          (globalThis as typeof globalThis & { api: LingoMateApi }).api.vocabulary.list({})
        )
        expect(listed).toEqual({ status: 'ok', entries: [] })
      } finally {
        await app.close()
      }
    })
  } finally {
    await server.close()
  }
})
