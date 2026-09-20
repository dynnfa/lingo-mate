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
    id: 'e3100000-0000-4000-8000-000000000001',
    term: 'apple',
    meaning: 'A round fruit with red or green skin.'
  },
  {
    id: 'e3100000-0000-4000-8000-000000000002',
    term: 'banana',
    meaning: 'A long yellow fruit.'
  },
  {
    id: 'e3100000-0000-4000-8000-000000000003',
    term: 'cherry',
    meaning: 'A small red fruit.'
  }
]

// 预写词库：三个词条供一轮完整练习使用。
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
      insert.run(fixture.id, fixture.term, fixture.meaning, `2026-09-20T1${index}:00:00.000Z`)
    }
  } finally {
    database.close()
  }
}

async function openPractice(window: Page): Promise<void> {
  await window.getByRole('button', { name: 'Start practicing' }).click()
  const page = window.getByRole('main', { name: 'Start practicing' })
  await expect(page).toBeVisible()
}

async function confirmCount(window: Page, count: number): Promise<void> {
  await window.locator('#vocabulary-practice-count').fill(String(count))
  await window.getByRole('button', { name: 'Confirm', exact: true }).click()
}

async function fillMeaning(window: Page, term: string, meaning: string): Promise<void> {
  await window.getByLabel(`Meaning of ${term}`).fill(meaning)
}

async function openMistakes(window: Page): Promise<void> {
  await window.getByRole('button', { name: 'Mistake book' }).click()
  await expect(window.getByRole('main', { name: 'Mistake book' })).toBeVisible()
}

test('collects wrong answers into the mistake book and keeps them across restarts', async () => {
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

        // cherry 答错（假模型把含 "wrong" 的答案标红），其余两词正确
        await fillMeaning(window, 'apple', 'A round fruit.')
        await fillMeaning(window, 'banana', 'A long yellow fruit.')
        await fillMeaning(window, 'cherry', 'totally wrong answer')
        await window.getByRole('button', { name: 'Submit for review' }).click()
        await expect(window.getByText('Some answers are wrong and marked below.')).toBeVisible()

        // 修改 cherry 后再次提交全部正确：后来答对不清除错题
        await fillMeaning(window, 'cherry', 'A small red fruit.')
        await window.getByRole('button', { name: 'Submit for review' }).click()
        await expect(window.getByText('All correct!')).toBeVisible()

        // 错题集：仅 cherry 一行，显示本次输入释义与 1 次错误
        await window.getByRole('button', { name: 'Back', exact: true }).click()
        await openMistakes(window)
        const row = window.getByRole('row').filter({ hasText: 'cherry' })
        await expect(row).toHaveCount(1)
        await expect(row).toContainText('totally wrong answer')
        await expect(row).toContainText('1 time')
        // 其他两词未答错，不出现在错题集中
        await expect(window.getByRole('row').filter({ hasText: 'apple' })).toHaveCount(0)
        await expect(window.getByRole('row').filter({ hasText: 'banana' })).toHaveCount(0)

        // 展开历史可查看输入释义
        await window.getByRole('button', { name: 'Show mistake history of "cherry"' }).click()
        const history = window.getByRole('group', { name: 'Mistake history of "cherry"' })
        await expect(history).toContainText('totally wrong answer')
      } finally {
        await app.close()
      }

      // 重启应用：错题仍可查看（持久化在本地数据库中）
      const relaunched = await launchApp(directory)
      try {
        const window = await relaunched.firstWindow()
        await waitForReady(window)
        await openMistakes(window)
        const row = window.getByRole('row').filter({ hasText: 'cherry' })
        await expect(row).toHaveCount(1)
        await expect(row).toContainText('totally wrong answer')
        await expect(row).toContainText('1 time')
      } finally {
        await relaunched.close()
      }
    }, 'lingo-mate-vocabulary-mistakes-')
  } finally {
    await server.close()
  }
})
