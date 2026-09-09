import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
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

interface SynonymWordFixture {
  word: string
  meaning: string
  distinction: string
}

interface SynonymGroupFixture {
  meaning: string
  words: SynonymWordFixture[]
}

// 六组近义词：首组三条词条验证跨行合并，含多行区别文本与长组释义；
// 第六组用于验证组级分页的「加载更多」。
const FIXTURES: SynonymGroupFixture[] = [
  {
    meaning: 'good enough',
    words: [
      {
        word: 'adequate',
        meaning: 'enough for a purpose',
        distinction: 'meets a minimum standard'
      },
      { word: 'acceptable', meaning: 'good enough', distinction: 'satisfactory' },
      {
        word: 'decent',
        meaning: 'of a good enough standard',
        distinction: 'informal quality judgment\noften used in speech'
      }
    ]
  },
  {
    meaning: 'very large',
    words: [
      { word: 'enormous', meaning: 'extremely large', distinction: 'size beyond normal scale' }
    ]
  },
  {
    meaning: 'very large',
    words: [{ word: 'huge', meaning: 'very big', distinction: 'general large size' }]
  },
  {
    meaning:
      'a long explanatory group meaning that must wrap inside the merged cell without breaking the centered alignment of the whole row group area',
    words: [{ word: 'tiny', meaning: 'very small', distinction: 'much smaller than average' }]
  },
  {
    meaning: 'fast',
    words: [{ word: 'quick', meaning: 'moving fast', distinction: 'speed of motion' }]
  },
  {
    meaning: 'quiet',
    words: [{ word: 'silent', meaning: 'without sound', distinction: 'no noise at all' }]
  }
]

// 预写已迁移到最新版本的近义词数据：不依赖模型调用，页面只做本地读取。
// 组 ID 使用固定递增 UUID，保证表格按 id 升序渲染时与夹具顺序一致。
function writeSynonymFixture(userDataPath: string): void {
  const database = new Database(join(userDataPath, 'lingo-mate.sqlite'))
  try {
    migrateDatabase(database)
    const insertGroup = database.prepare('INSERT INTO synonym_group VALUES (?, ?)')
    const insertWord = database.prepare(
      'INSERT INTO synonym(id, word, meaning, groupid, distinction) VALUES (?, ?, ?, ?, ?)'
    )
    for (const [index, fixture] of FIXTURES.entries()) {
      const groupid = `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`
      insertGroup.run(groupid, fixture.meaning)
      for (const word of fixture.words)
        insertWord.run(randomUUID(), word.word, word.meaning, groupid, word.distinction)
    }
  } finally {
    database.close()
  }
}

async function openRecordedSynonyms(window: Page): Promise<void> {
  await window.getByRole('button', { name: 'Recorded vocabulary' }).click()
  const page = window.locator('main.recorded-page')
  await expect(page).toBeVisible()
  // 默认选中词汇详情；切换到近义词菜单读取分组表格。
  await window.getByRole('button', { name: 'Synonyms' }).click()
  await expect(window.locator('.synonym-table')).toBeVisible()
}

test('shows recorded synonym groups with merged centered cells and group paging', async () => {
  await withTempUserData(async (directory) => {
    writeLocalePreference(directory, 'en')
    writeSynonymFixture(directory)

    const app = await launchApp(directory)
    try {
      const window = await app.firstWindow()
      await waitForReady(window)
      await openRecordedSynonyms(window)

      const headers = window.locator('.synonym-table thead th')
      await expect(headers).toHaveText(['Group meaning', 'Word', 'Word meaning', 'Distinction'])

      // 首组三条词条：最左单元格跨三行合并且在整个区域内水平、垂直居中。
      const firstGroup = window.locator('.synonym-table tbody').first()
      const merged = firstGroup.locator('th.synonym-group-meaning')
      await expect(merged).toHaveAttribute('rowspan', '3')
      await expect(merged).toHaveAttribute('scope', 'rowgroup')
      await expect(merged).toHaveText('good enough')
      await expect(merged).toHaveCSS('text-align', 'center')
      await expect(merged).toHaveCSS('vertical-align', 'middle')
      await expect(firstGroup.locator('tr')).toHaveCount(3)
      // 组释义只渲染一次，后续行不补空单元格。
      await expect(
        window.locator('.synonym-table th.synonym-group-meaning', {
          hasText: 'good enough'
        })
      ).toHaveCount(1)
      // 多行区别文本原样保留。
      await expect(firstGroup.getByText('informal quality judgment')).toBeVisible()

      // 释义相同但组不同的 huge/enormous 分别成组展示。
      await expect(
        window.locator('.synonym-table th.synonym-group-meaning', { hasText: 'very large' })
      ).toHaveCount(2)

      // 长组释义在合并单元格内换行，居中样式保持。
      const longMerged = window
        .locator('.synonym-table th.synonym-group-meaning')
        .filter({ hasText: 'a long explanatory group meaning' })
      await expect(longMerged).toHaveCSS('text-align', 'center')
      await expect(longMerged).toHaveCSS('vertical-align', 'middle')

      // 组级分页：首屏五组，加载更多补齐第六组后按钮消失。
      await expect(window.locator('.synonym-table tbody')).toHaveCount(5)
      await window.getByRole('button', { name: 'Load more' }).click()
      await expect(window.getByText('silent')).toBeVisible()
      await expect(window.locator('.synonym-table tbody')).toHaveCount(6)
      await expect(window.getByRole('button', { name: 'Load more' })).toHaveCount(0)

      // 回归：切回词汇菜单显示空词库，再回近义词仍读取同一分组。
      await window.getByRole('button', { name: 'Vocabulary' }).click()
      await expect(window.getByText('No saved vocabulary yet')).toBeVisible()
      await expect(window.locator('.synonym-table')).toHaveCount(0)
      await window.getByRole('button', { name: 'Synonyms' }).click()
      await expect(window.locator('.synonym-table tbody')).toHaveCount(5)

      // Escape 退出已记录页。
      await window.keyboard.press('Escape')
      await expect(window.locator('main.recorded-page')).toBeHidden()
    } finally {
      await app.close()
    }
  }, 'lingo-mate-recorded-synonym-')
})

test('shows the empty synonym state in Chinese', async () => {
  await withTempUserData(async (directory) => {
    writeLocalePreference(directory, 'zh-CN')

    const app = await launchApp(directory)
    try {
      const window = await app.firstWindow()
      await waitForReady(window)
      await window.getByRole('button', { name: '已记录词汇' }).click()
      await window.getByRole('button', { name: '近义词' }).click()

      await expect(window.getByText('还没有收藏近义词')).toBeVisible()
      await expect(window.locator('.synonym-table')).toHaveCount(0)
    } finally {
      await app.close()
    }
  }, 'lingo-mate-recorded-synonym-empty-')
})
