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
import { startSentencePracticeServer } from '../integration/fixtures/sentence-practice-server'
import { migrateDatabase } from '../../src/database/migrations'

const FIXTURES = [
  {
    id: 'e4000000-0000-4000-8000-000000000001',
    term: 'apple',
    meaning: 'A round fruit with red or green skin.'
  },
  {
    id: 'e4000000-0000-4000-8000-000000000002',
    term: 'banana',
    meaning: null
  },
  {
    id: 'e4000000-0000-4000-8000-000000000003',
    term: 'cherry',
    meaning: 'A small red fruit.'
  }
]

// 预写词库：banana 的历史 meaning 为 NULL，提示按通常词义生成。
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
      insert.run(fixture.id, fixture.term, fixture.meaning, `2026-09-10T1${index}:00:00.000Z`)
    }
  } finally {
    database.close()
  }
}

async function openSentencePractice(window: Page): Promise<void> {
  await window.getByRole('button', { name: 'Start practicing' }).click()
  const page = window.locator('main.practice-page')
  await expect(page).toBeVisible()
  await page.getByRole('button', { name: 'Sentence practice' }).click()
  await expect(page.getByRole('button', { name: 'Sentence practice' })).toHaveAttribute(
    'aria-current',
    'true'
  )
}

test('runs a sentence practice round with hints, review and retry', async () => {
  const server = await startSentencePracticeServer()
  try {
    await withTempUserData(async (directory) => {
      await writeLocalePreference(directory, 'en')
      await writeModelsConfig(directory, server.baseUrl, 'test-model')
      writeVocabularyFixture(directory)
      const app = await launchApp(directory)
      try {
        const window = await app.firstWindow()
        await waitForReady(window)
        await openSentencePractice(window)

        // 随机三词 + 模型生成的短语提示
        await expect(window.locator('.sentence-practice-word')).toHaveCount(3)
        await expect(window.locator('.sentence-practice-hint')).toHaveCount(3)
        // 提示请求显式携带语言规则（界面与练习语言均为英语）
        expect(server.requests[0].messages[0].content).toContain('English')
        expect(server.requests[0].messages[0].content).toContain(
          'phrase must be written in English'
        )

        // 含 wrong 的答案：一个词未使用 + 语法问题 + 建议改写
        await window.locator('#sentence-practice-answer').fill('This is a wrong sentence.')
        await window.getByRole('button', { name: 'Submit for review' }).click()
        await expect(window.getByRole('heading', { name: 'Review' })).toBeVisible()
        await expect(window.getByText('Not used')).toBeVisible()
        await expect(window.getByText('Incorrect')).toBeVisible()
        await expect(window.getByText('a wrong sentence', { exact: true })).toBeVisible()
        await expect(window.getByRole('heading', { name: 'Suggested revision' })).toBeVisible()
        expect(server.requests).toHaveLength(2)
        expect(server.requests[1].messages[0].content).toContain(
          'feedback, explanation and summary must be written in English'
        )

        // 修改答案重试：全部正确
        await window
          .locator('#sentence-practice-answer')
          .fill('I ate an apple, a bunch of bananas and ripe cherries.')
        await expect(window.getByRole('heading', { name: 'Review' })).toHaveCount(0)
        await window.getByRole('button', { name: 'Submit for review' }).click()
        await expect(window.getByText('Everything is correct!')).toBeVisible()
        await expect(window.getByText('Not used')).toHaveCount(0)
        expect(server.requests).toHaveLength(3)
      } finally {
        await app.close()
      }
    }, 'lingo-mate-sentence-practice-')
  } finally {
    await server.close()
  }
})

test('switching menus aborts in-flight hint generation and starts a fresh round', async () => {
  const server = await startSentencePracticeServer({ hangHints: true })
  try {
    await withTempUserData(async (directory) => {
      await writeLocalePreference(directory, 'en')
      await writeModelsConfig(directory, server.baseUrl, 'test-model')
      writeVocabularyFixture(directory)
      const app = await launchApp(directory)
      try {
        const window = await app.firstWindow()
        await waitForReady(window)
        await openSentencePractice(window)

        await expect(window.locator('.sentence-practice-word')).toHaveCount(3)
        await expect(window.getByText('Generating hints…')).toBeVisible()
        expect(server.requests).toHaveLength(1)

        // 切回词汇练习：造句详情卸载，在途提示请求被中止
        await window
          .locator('main.practice-page')
          .getByRole('button', { name: 'Vocabulary practice' })
          .click()
        await expect(() => {
          expect(server.abortedHints()).toBeGreaterThanOrEqual(1)
        }).toPass()

        // 切回造句练习：自动开始新一轮并重新生成提示
        await window
          .locator('main.practice-page')
          .getByRole('button', { name: 'Sentence practice' })
          .click()
        await expect(window.locator('.sentence-practice-word')).toHaveCount(3)
        await expect(window.getByText('Generating hints…')).toBeVisible()
        expect(server.requests).toHaveLength(2)
      } finally {
        await app.close()
      }
    }, 'lingo-mate-sentence-practice-abort-')
  } finally {
    await server.close()
  }
})
