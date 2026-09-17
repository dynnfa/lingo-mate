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

interface PhraseFixture {
  phrase: string
  explantation: string
  example: string
}

const FIXTURES: PhraseFixture[] = [
  {
    phrase: 'break even',
    explantation: '收支相抵，不赚不赔。',
    example: 'The firm broke even this year.'
  },
  {
    phrase: 'look forward to',
    explantation: '期待，盼望（某件将发生的事）。',
    example: 'I look forward to hearing from you.'
  },
  {
    phrase: 'piece of cake',
    explantation: '轻而易举的事。',
    example: 'The exam was a piece of cake.'
  }
]

// 预写已迁移到最新版本的短语数据：不依赖模型调用，页面只做本地读取与删除。
function writePhraseFixture(userDataPath: string): void {
  const database = new Database(join(userDataPath, 'lingo-mate.sqlite'))
  try {
    migrateDatabase(database)
    const insert = database.prepare(
      'INSERT INTO phrase (phrase, explantation, example) VALUES (?, ?, ?)'
    )
    for (const fixture of FIXTURES) {
      insert.run(fixture.phrase, fixture.explantation, fixture.example)
    }
  } finally {
    database.close()
  }
}

async function openRecordedPhrases(window: Page): Promise<void> {
  await window.getByRole('button', { name: 'Recorded vocabulary' }).click()
  const page = window.getByRole('main', { name: 'Recorded vocabulary' })
  await expect(page).toBeVisible()
  // 默认选中词汇详情；切换到短语菜单读取短语表格。
  await window.getByRole('button', { name: 'Phrases' }).click()
  await expect(window.locator('.phrase-table')).toBeVisible()
}

test('shows recorded phrases in a table and deletes a single entry across restarts', async () => {
  await withTempUserData(async (directory) => {
    writeLocalePreference(directory, 'en')
    writePhraseFixture(directory)

    let app = await launchApp(directory)
    try {
      const window = await app.firstWindow()
      await waitForReady(window)
      await openRecordedPhrases(window)

      // 表格按 phrase BINARY 升序展示全部短语，操作列在最右侧。
      const headers = window.locator('.phrase-table thead th')
      await expect(headers).toHaveText(['Phrase', 'Explanation', 'Example', 'Actions'])
      const row = window.locator('.phrase-table tbody tr')
      await expect(row).toHaveCount(3)
      await expect(window.getByRole('button', { name: 'Delete break even' })).toBeVisible()
      await expect(window.getByText('期待，盼望（某件将发生的事）。')).toBeVisible()
      await expect(window.getByText('I look forward to hearing from you.')).toBeVisible()

      // 取消删除：确认对话框关闭，行保留。
      await window.getByRole('button', { name: 'Delete break even' }).click()
      const dialog = window.getByRole('dialog', { name: 'Delete phrase' })
      await expect(dialog).toBeVisible()
      await expect(dialog).toContainText('"break even"')
      await dialog.getByRole('button', { name: 'Cancel' }).click()
      await expect(dialog).toBeHidden()
      await expect(window.getByRole('button', { name: 'Delete break even' })).toBeVisible()

      // 确认删除：该行移除，其余行保留。
      await window.getByRole('button', { name: 'Delete break even' }).click()
      await dialog.getByRole('button', { name: 'Delete', exact: true }).click()
      await expect(dialog).toBeHidden()
      await expect(window.locator('.phrase-table tbody tr')).toHaveCount(2)
      await expect(window.getByRole('button', { name: 'Delete break even' })).toHaveCount(0)
      await expect(window.getByRole('button', { name: 'Delete look forward to' })).toBeVisible()
      await expect(window.getByRole('button', { name: 'Delete piece of cake' })).toBeVisible()

      // 回归：切回词汇菜单显示空词库，不残留短语视图。
      await window.getByRole('button', { name: 'Vocabulary' }).click()
      await expect(window.locator('.vocabulary-table')).toHaveCount(0)
      await expect(window.getByText('No saved vocabulary yet')).toBeVisible()
      // 重新进入短语菜单仍读取剩余两条。
      await window.getByRole('button', { name: 'Phrases' }).click()
      await expect(window.locator('.phrase-table tbody tr')).toHaveCount(2)

      await app.close()
    } finally {
      await app.close()
    }

    // 重启后删除结果持久化：break even 不再出现，其余短语仍可读取。
    app = await launchApp(directory)
    try {
      const window = await app.firstWindow()
      await waitForReady(window)
      await openRecordedPhrases(window)

      const row = window.locator('.phrase-table tbody tr')
      await expect(row).toHaveCount(2)
      await expect(window.getByRole('button', { name: 'Delete break even' })).toHaveCount(0)
      await expect(window.getByText('收支相抵，不赚不赔。')).toHaveCount(0)
      await expect(window.getByText('The exam was a piece of cake.')).toBeVisible()
    } finally {
      await app.close()
    }
  }, 'lingo-mate-recorded-phrase-')
})

test('keeps the recorded page open when Escape closes the phrase delete dialog', async () => {
  await withTempUserData(async (directory) => {
    writeLocalePreference(directory, 'en')
    writePhraseFixture(directory)

    const app = await launchApp(directory)
    try {
      const window = await app.firstWindow()
      await waitForReady(window)
      await openRecordedPhrases(window)

      await window.getByRole('button', { name: 'Delete look forward to' }).click()
      const dialog = window.getByRole('dialog', { name: 'Delete phrase' })
      await expect(dialog).toBeVisible()
      await window.keyboard.press('Escape')

      // Escape 只关闭对话框，页面保持挂载。
      await expect(dialog).toBeHidden()
      const page = window.getByRole('main', { name: 'Recorded vocabulary' })
      await expect(page).toBeVisible()
      await expect(window.getByRole('button', { name: 'Delete look forward to' })).toBeVisible()

      // 对话框关闭后 Escape 仍可退出已记录页。
      await window.keyboard.press('Escape')
      await expect(page).toBeHidden()
    } finally {
      await app.close()
    }
  }, 'lingo-mate-recorded-phrase-escape-')
})
