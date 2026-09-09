import { join } from 'node:path'
import Database from 'better-sqlite3'
import type { Page } from '@playwright/test'
import {
  expect,
  launchApp,
  test,
  waitForReady,
  withTempUserData,
  writeLocalePreference
} from './helpers'
import { migrateDatabase } from '../../src/database/migrations'

interface VocabularyFixture {
  id: string
  term: string
  createdAt: string
}

const FIXTURES: VocabularyFixture[] = [
  {
    id: 'e2000000-0000-4000-8000-000000000001',
    term: 'apple',
    createdAt: '2026-09-07T10:00:00.000Z'
  },
  {
    id: 'e2000000-0000-4000-8000-000000000002',
    term: 'banana',
    createdAt: '2026-09-07T09:00:00.000Z'
  },
  {
    id: 'e2000000-0000-4000-8000-000000000003',
    term: 'cherry',
    createdAt: '2026-09-07T08:00:00.000Z'
  }
]

// 预写已迁移到最新版本的词库数据：不依赖模型调用，页面只做本地读取与删除。
function writeVocabularyFixture(userDataPath: string): void {
  const database = new Database(join(userDataPath, 'lingo-mate.sqlite'))
  try {
    migrateDatabase(database)
    const insert = database.prepare(
      `INSERT INTO vocabulary
       (id, term, phonetic, meaning, concept, example_sentences, model_id, prompt_version, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    for (const fixture of FIXTURES) {
      insert.run(
        fixture.id,
        fixture.term,
        '/ˈæpəl/',
        `The meaning of ${fixture.term}.`,
        `The concept of ${fixture.term}.`,
        JSON.stringify([`A sentence about ${fixture.term}.`]),
        'fixture-model',
        'vocabulary-tools-v2',
        fixture.createdAt
      )
    }
  } finally {
    database.close()
  }
}

async function openRecordedVocabulary(window: Page): Promise<void> {
  await window.getByRole('button', { name: 'Recorded vocabulary' }).click()
  const page = window.locator('main.recorded-page')
  await expect(page).toBeVisible()
  await expect(window.locator('.vocabulary-table')).toBeVisible()
}

test('shows recorded vocabulary in a table and deletes a single entry across restarts', async () => {
  await withTempUserData(async (directory) => {
    writeLocalePreference(directory, 'en')
    writeVocabularyFixture(directory)

    let app = await launchApp(directory)
    try {
      const window = await app.firstWindow()
      await waitForReady(window)
      await openRecordedVocabulary(window)

      // 表格按创建时间倒序展示全部词条，操作列在最右侧。
      const headers = window.locator('.vocabulary-table thead th')
      await expect(headers).toHaveText([
        'Word',
        'Phonetic',
        'Meaning',
        'Concept',
        'Examples',
        'Recorded at',
        'Actions'
      ])
      const row = window.locator('.vocabulary-table tbody tr')
      await expect(row).toHaveCount(3)
      await expect(window.getByRole('button', { name: 'Delete apple' })).toBeVisible()
      await expect(window.getByText('The meaning of apple.')).toBeVisible()

      // 取消删除：确认对话框关闭，行保留。
      await window.getByRole('button', { name: 'Delete apple' }).click()
      const dialog = window.locator('.dialog-card')
      await expect(dialog).toBeVisible()
      await expect(dialog).toContainText('"apple"')
      await dialog.getByRole('button', { name: 'Cancel' }).click()
      await expect(dialog).toBeHidden()
      await expect(window.getByRole('button', { name: 'Delete apple' })).toBeVisible()

      // 确认删除：该行移除，其余行保留。
      await window.getByRole('button', { name: 'Delete apple' }).click()
      await dialog.getByRole('button', { name: 'Delete', exact: true }).click()
      await expect(dialog).toBeHidden()
      await expect(window.locator('.vocabulary-table tbody tr')).toHaveCount(2)
      await expect(window.getByRole('button', { name: 'Delete apple' })).toHaveCount(0)
      await expect(window.getByRole('button', { name: 'Delete banana' })).toBeVisible()
      await expect(window.getByRole('button', { name: 'Delete cherry' })).toBeVisible()

      await app.close()
    } finally {
      await app.close()
    }

    // 重启后删除结果持久化：apple 不再出现，其余词条仍可读取。
    app = await launchApp(directory)
    try {
      const window = await app.firstWindow()
      await waitForReady(window)
      await openRecordedVocabulary(window)

      const row = window.locator('.vocabulary-table tbody tr')
      await expect(row).toHaveCount(2)
      await expect(window.getByRole('button', { name: 'Delete apple' })).toHaveCount(0)
      await expect(window.getByText('The meaning of banana.')).toBeVisible()
      await expect(window.getByText('The meaning of cherry.')).toBeVisible()
    } finally {
      await app.close()
    }
  }, 'lingo-mate-recorded-vocabulary-')
})

test('keeps the recorded page open when Escape closes the delete dialog', async () => {
  await withTempUserData(async (directory) => {
    writeLocalePreference(directory, 'en')
    writeVocabularyFixture(directory)

    const app = await launchApp(directory)
    try {
      const window = await app.firstWindow()
      await waitForReady(window)
      await openRecordedVocabulary(window)

      await window.getByRole('button', { name: 'Delete apple' }).click()
      const dialog = window.locator('.dialog-card')
      await expect(dialog).toBeVisible()
      await window.keyboard.press('Escape')

      // Escape 只关闭对话框，页面保持挂载。
      await expect(dialog).toBeHidden()
      const page = window.locator('main.recorded-page')
      await expect(page).toBeVisible()
      await expect(window.getByRole('button', { name: 'Delete apple' })).toBeVisible()

      // 对话框关闭后 Escape 仍可退出已记录页。
      await window.keyboard.press('Escape')
      await expect(page).toBeHidden()
    } finally {
      await app.close()
    }
  }, 'lingo-mate-recorded-vocabulary-')
})

test('reports an empty vocabulary state when nothing is recorded', async () => {
  await withTempUserData(async (directory) => {
    writeLocalePreference(directory, 'en')
    const database = new Database(join(directory, 'lingo-mate.sqlite'))
    migrateDatabase(database)
    database.close()

    const app = await launchApp(directory)
    try {
      const window = await app.firstWindow()
      await waitForReady(window)
      await window.getByRole('button', { name: 'Recorded vocabulary' }).click()
      await expect(window.locator('main.recorded-page')).toBeVisible()

      await expect(window.getByText('No saved vocabulary yet')).toBeVisible()
      await expect(window.locator('.vocabulary-table')).toHaveCount(0)
    } finally {
      await app.close()
    }
  }, 'lingo-mate-recorded-vocabulary-empty-')
})
