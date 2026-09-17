import { join } from 'node:path'
import Database from 'better-sqlite3'
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
import { startSynonymServer } from '../integration/fixtures/synonym-server'

test('synonym command groups, skips, handles failures and cancellation, and restores history', async () => {
  const server = await startSynonymServer()
  try {
    await withTempUserData(async (directory) => {
      await writeLocalePreference(directory, 'en')
      await writeModelsConfig(directory, server.baseUrl, 'test-model')
      let app = await launchApp(directory)
      try {
        let window = await app.firstWindow()
        await waitForReady(window)
        const submit = async (text: string): Promise<void> => {
          await window.locator('#message').fill(`/synonym ${text}`)
          await window.locator('#message').press('Enter')
        }
        await submit('adequate, decent')
        await expect(window.locator('.message.assistant').last()).toContainText('decent: added')
        await window.locator('#message').fill('/synonym')
        await window.locator('#message').press('Enter')
        await expect(window.locator('#message')).toHaveValue('/synonym ')
        await submit('ADEQUATE，decent')
        await expect(window.locator('.message.assistant').last()).toContainText(
          'decent: already saved'
        )
        expect(server.words).toEqual(['adequate', 'decent'])
        await submit('enormous, broken')
        await expect(window.locator('.message.assistant').last()).toContainText(
          'broken: Invalid tool response'
        )
        await submit('slow, untouched')
        await expect.poll(() => server.words.includes('slow')).toBe(true)
        await window.getByRole('button', { name: 'Cancel', exact: true }).click()
        await expect(window.locator('.message.assistant').last()).toContainText(
          'untouched: cancelled'
        )
        await window.locator('#message').fill('Hello')
        await expect(window.getByRole('button', { name: 'Send', exact: true })).toBeEnabled()
        const database = new Database(join(directory, 'lingo-mate.sqlite'), { readonly: true })
        try {
          expect(database.prepare('SELECT * FROM synonym_group').all()).toHaveLength(2)
          expect(database.prepare('SELECT * FROM synonym').all()).toHaveLength(3)
          const usage = database
            .prepare("SELECT * FROM llm_request_usage WHERE operation = 'synonym_analysis'")
            .all()
          expect(usage.length).toBeGreaterThanOrEqual(9)
        } finally {
          database.close()
        }
        await app.close()
        app = await launchApp(directory)
        window = await app.firstWindow()
        await waitForReady(window)
        // 启动打开空白草稿；经侧栏打开原会话后历史完整恢复
        await openLatestConversation(window)
        await expect(window.locator('.message.assistant')).toHaveCount(4)
        await expect(window.locator('.message.assistant').last()).toContainText(
          'untouched: cancelled'
        )
      } finally {
        await app.close()
      }
    }, 'lingo-synonym-')
  } finally {
    await server.close()
  }
})
