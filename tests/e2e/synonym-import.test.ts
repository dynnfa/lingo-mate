import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
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

test('frozen synonym crash retains a committed word and retries only the unfinished word', async () => {
  test.skip(process.platform === 'win32', 'Child PID inspection requires ps')
  const server = await startSynonymServer()
  try {
    await withTempUserData(async (directory) => {
      await writeLocalePreference(directory, 'en')
      await writeModelsConfig(directory, server.baseUrl, 'test-model')
      const app = await launchApp(directory, { model: 'remote', agentBundle: true })
      try {
        const window = await app.firstWindow()
        await waitForReady(window)
        await window.locator('#message').fill('/synonym adequate, slow')
        await window.locator('#message').press('Enter')
        await expect.poll(() => server.words.includes('slow')).toBe(true)
        const row = execFileSync('/bin/ps', ['-axo', 'pid=,ppid=,command='], { encoding: 'utf8' })
          .split('\n')
          .find((row) => {
            const [, parent, ...command] = row.trim().split(/\s+/)
            return Number(parent) === app.process().pid && /lingo-agent/.test(command.join(' '))
          })
        expect(row).toBeTruthy()
        process.kill(Number(row!.trim().split(/\s+/)[0]), 'SIGKILL')
        await expect(window.getByRole('button', { name: 'Retry', exact: true })).toBeVisible()
        const database = new Database(join(directory, 'lingo-mate.sqlite'), { readonly: true })
        try {
          expect(database.prepare('SELECT word FROM synonym').all()).toEqual([{ word: 'adequate' }])
          const execution = database
            .prepare(
              "SELECT batch_json FROM conversation_skill_executions WHERE skill_id = 'synonym'"
            )
            .get() as { batch_json: string }
          expect(JSON.parse(execution.batch_json).finalized).toBe(false)
        } finally {
          database.close()
        }
        await window.getByRole('button', { name: 'Retry', exact: true }).click()
        await expect(window.locator('.message.assistant').last()).toContainText(
          'slow: unrecognized English word'
        )
        await expect(window.locator('.message.assistant').last()).toContainText('adequate: added')
        expect(server.words).toEqual(['adequate', 'slow', 'slow'])
      } finally {
        await app.close()
      }
    }, 'lingo-synonym-crash-')
  } finally {
    await server.close()
  }
})

for (const agentBundle of [false, true]) {
  test(`synonym ${agentBundle ? 'bundle' : 'interpreter'} groups, cancels and restores history`, async () => {
    const server = await startSynonymServer()
    try {
      await withTempUserData(async (directory) => {
        await writeLocalePreference(directory, 'en')
        await writeModelsConfig(directory, server.baseUrl, 'test-model')
        let app = await launchApp(directory, { agentBundle })
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
          await submit('fresh, slow, untouched')
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
            expect(database.prepare('SELECT * FROM synonym').all()).toHaveLength(4)
            const usage = database
              .prepare("SELECT * FROM llm_request_usage WHERE operation = 'synonym_analysis'")
              .all()
            expect(usage.length).toBeGreaterThanOrEqual(9)
          } finally {
            database.close()
          }
          await app.close()
          app = await launchApp(directory, { agentBundle })
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
}

for (const locale of ['zh-CN', 'en'] as const) {
  test(`frozen synonym graph preserves ${locale} instructions`, async () => {
    const server = await startSynonymServer()
    try {
      await withTempUserData(async (directory) => {
        await writeLocalePreference(directory, locale)
        await writeModelsConfig(directory, server.baseUrl, 'test-model')
        const app = await launchApp(directory, { model: 'remote', agentBundle: true })
        try {
          const window = await app.firstWindow()
          await waitForReady(window)
          await window.locator('#message').fill('/synonym adequate, decent')
          await window.locator('#message').press('Enter')
          await expect(window.locator('.message.assistant').last()).toContainText('decent', {
            timeout: 40000
          })
          expect(server.words).toEqual(['adequate', 'decent'])
          const analysisPrompts = server.prompts.filter((prompt) =>
            prompt.startsWith('Analyze the single English word')
          )
          expect(analysisPrompts).toHaveLength(4)
          for (const prompt of analysisPrompts) {
            expect(prompt).toContain(
              `meaning and distinction must be written in ${locale === 'zh-CN' ? 'Simplified Chinese' : 'English'}`
            )
            expect(prompt).toContain('Never create before inspecting all pages')
          }
        } finally {
          await app.close()
        }
      }, 'lingo-synonym-language-')
    } finally {
      await server.close()
    }
  })
}
