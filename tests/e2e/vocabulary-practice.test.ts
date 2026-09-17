import { join } from 'node:path'
import Database from 'better-sqlite3'
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
import { startVocabularyPracticeServer } from '../integration/fixtures/vocabulary-practice-server'
import { migrateDatabase } from '../../src/database/migrations'

const FIXTURES = [
  {
    id: 'e3000000-0000-4000-8000-000000000001',
    term: 'apple',
    meaning: 'A round fruit with red or green skin.'
  },
  {
    id: 'e3000000-0000-4000-8000-000000000002',
    term: 'banana',
    meaning: null
  },
  {
    id: 'e3000000-0000-4000-8000-000000000003',
    term: 'cherry',
    meaning: 'A small red fruit.'
  }
]

// 预写词库：banana 的历史 meaning 为 NULL，练习仍可用，模型按词义判断。
function writeVocabularyFixture(userDataPath: string): void {
  const database = new Database(join(userDataPath, 'lingo-mate.sqlite'))
  try {
    migrateDatabase(database)
    const insert = database.prepare(
      `INSERT INTO vocabulary
       (id, term, phonetic, meaning, concept, example_sentences, model_id, prompt_version, created_at)
       VALUES (?, ?, NULL, ?, NULL, NULL, 'fixture-model', 'vocabulary-tools-v2', ?)`
    )
    for (const [index, fixture] of FIXTURES.entries()) {
      insert.run(fixture.id, fixture.term, fixture.meaning, `2026-09-07T1${index}:00:00.000Z`)
    }
  } finally {
    database.close()
  }
}

async function openPractice(window: Page): Promise<void> {
  await window.getByRole('button', { name: 'Start practicing' }).click()
  const page = window.getByRole('main', { name: 'Start practicing' })
  await expect(page).toBeVisible()
  await expect(page.getByRole('button', { name: 'Vocabulary practice' })).toHaveAttribute(
    'aria-current',
    'true'
  )
}

async function confirmCount(window: Page, count: number): Promise<void> {
  await window.locator('#vocabulary-practice-count').fill(String(count))
  await window.getByRole('button', { name: 'Confirm', exact: true }).click()
}

async function fillMeaning(window: Page, term: string, meaning: string): Promise<void> {
  await window.getByLabel(`Meaning of ${term}`).fill(meaning)
}

test('marks wrong meanings in red through a model tool call and reports the verdict', async () => {
  const server = await startVocabularyPracticeServer()
  try {
    await withTempUserData(async (directory) => {
      await writeLocalePreference(directory, 'en')
      await writeModelsConfig(directory, server.baseUrl, 'test-model')
      writeVocabularyFixture(directory)
      const app = await launchApp(directory)
      try {
        const window = await app.firstWindow()
        await waitForReady(window)
        await openPractice(window)
        // 请求 5 个但词库只有 3 个：全部进入本轮并提示实际数量。
        await confirmCount(window, 5)
        await expect(window.getByText('Only 3 words are saved')).toBeVisible()
        await expect(window.locator('.vocabulary-practice-row')).toHaveCount(3)

        await fillMeaning(window, 'apple', 'A round fruit.')
        await fillMeaning(window, 'banana', 'A long yellow fruit.')
        await fillMeaning(window, 'cherry', 'totally wrong answer')
        await window.getByRole('button', { name: 'Submit for review' }).click()

        // cherry 被标红：红色样式 + 图标文本 + 原因；其余行保持正常。
        await expect(window.getByText('Some answers are wrong and marked below.')).toBeVisible()
        await expect(window.getByText('Every meaning is correct.')).toHaveCount(0)
        const cherryInput = window.getByLabel('Meaning of cherry')
        await expect(cherryInput).toHaveClass(/vocabulary-practice-input-marked/)
        await expect(cherryInput).toHaveAttribute('aria-invalid', 'true')
        await expect(window.getByText('The meaning of cherry does not match.')).toBeVisible()
        await expect(window.getByLabel('Meaning of apple')).not.toHaveClass(
          /vocabulary-practice-input-marked/
        )
        // 工具参数来自校验后的快照 ID：两次模型请求（标红 + 最终反馈）。
        expect(server.requests).toHaveLength(2)
        expect(server.requests[0].tools?.[0].function.name).toBe('mark_text_red')
        expect(server.requests[0].tool_choice).toBe('auto')

        await expect(cherryInput).toBeEditable()
        await fillMeaning(window, 'cherry', 'A small red fruit.')
        await expect(window.locator('.vocabulary-practice-input-marked')).toHaveCount(0)
        await expect(window.getByText('Some answers are wrong and marked below.')).toHaveCount(0)
        await window.getByRole('button', { name: 'Submit for review' }).click()
        await expect(window.getByText('All correct!')).toBeVisible()
        expect(server.requests).toHaveLength(3)
      } finally {
        await app.close()
      }
    }, 'lingo-mate-vocabulary-practice-')
  } finally {
    await server.close()
  }
})

test('completes an all-correct round without any tool call', async () => {
  const server = await startVocabularyPracticeServer()
  try {
    await withTempUserData(async (directory) => {
      await writeLocalePreference(directory, 'en')
      await writeModelsConfig(directory, server.baseUrl, 'test-model')
      writeVocabularyFixture(directory)
      const app = await launchApp(directory)
      try {
        const window = await app.firstWindow()
        await waitForReady(window)
        await openPractice(window)
        await confirmCount(window, 3)

        for (const term of ['apple', 'banana', 'cherry']) {
          await fillMeaning(window, term, 'a kind of fruit')
        }
        await window.getByRole('button', { name: 'Submit for review' }).click()

        await expect(window.getByText('All correct!')).toBeVisible()
        await expect(window.getByText('Every meaning is correct.')).toBeVisible()
        await expect(window.locator('.vocabulary-practice-input-marked')).toHaveCount(0)
        // 全部正确：零次工具调用，只有一次最终反馈请求。
        expect(server.requests).toHaveLength(1)
        expect(server.requests[0].tools?.[0].function.name).toBe('mark_text_red')
      } finally {
        await app.close()
      }
    }, 'lingo-mate-vocabulary-practice-correct-')
  } finally {
    await server.close()
  }
})

test('shows an empty state when the vocabulary has no entries', async () => {
  await withTempUserData(async (directory) => {
    await writeLocalePreference(directory, 'en')
    const database = new Database(join(directory, 'lingo-mate.sqlite'))
    migrateDatabase(database)
    database.close()

    const app = await launchApp(directory)
    try {
      const window = await app.firstWindow()
      await waitForReady(window)
      await openPractice(window)
      await confirmCount(window, 10)

      await expect(window.getByText('No vocabulary to practice yet')).toBeVisible()
      await expect(window.locator('.vocabulary-practice-row')).toHaveCount(0)
      await expect(window.getByRole('button', { name: 'Submit for review' })).toHaveCount(0)
    } finally {
      await app.close()
    }
  }, 'lingo-mate-vocabulary-practice-empty-')
})
