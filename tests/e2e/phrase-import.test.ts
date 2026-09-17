import { join } from 'node:path'
import Database from 'better-sqlite3'
import type { Page } from '@playwright/test'
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
import { startPhraseServer } from '../integration/fixtures/phrase-server'

// 选择器路径：键入 /phrase 并按 Enter 选中候选，进入参数输入状态。
async function selectPhrase(window: Page): Promise<void> {
  const input = window.locator('#message')
  await input.fill('/phrase')
  await input.press('Enter')
  await expect(input).toHaveValue('/phrase ')
  await expect(window.getByRole('region', { name: 'Conversation history' })).toBeVisible()
}

// 直接输入路径：完整 /phrase 命令不经过选择器，Enter 直接按技能提交。
async function submitTypedPhrase(window: Page, text: string): Promise<void> {
  await window.locator('#message').fill(`/phrase ${text}`)
  await window.locator('#message').press('Enter')
}

async function submitPickedPhrase(window: Page, text: string): Promise<void> {
  await selectPhrase(window)
  await window.locator('#message').fill(`/phrase ${text}`)
  await window.locator('#message').press('Enter')
}

function readPhraseRows(directory: string): Array<Record<string, string>> {
  const database = new Database(join(directory, 'lingo-mate.sqlite'), { readonly: true })
  try {
    return database
      .prepare('SELECT phrase, explantation, example FROM phrase ORDER BY phrase')
      .all() as Array<Record<string, string>>
  } finally {
    database.close()
  }
}

test('submits typed and picked /phrase commands, persists three-field rows, and restores history', async () => {
  const server = await startPhraseServer()
  try {
    await withTempUserData(async (directory) => {
      await writeLocalePreference(directory, 'en')
      await writeModelsConfig(directory, server.baseUrl, 'test-model')
      let app = await launchApp(directory)
      try {
        let window = await app.firstWindow()
        await waitForReady(window)

        // 直接输入：多行短语，含空行与批内重复
        await submitTypedPhrase(window, 'look forward to\nbreak even\n\nlook forward to')
        await expect(window.locator('.message.user').last()).toContainText(
          '/phrase look forward to'
        )
        const firstReply = window.locator('.message.assistant').last()
        await expect(firstReply).toContainText('Processed 3 phrases')
        await expect(firstReply).toContainText('2 added')
        await expect(firstReply).toContainText('look forward to and break even')
        await expect(firstReply).toContainText('1 repeated in this input')
        expect(server.phrases).toEqual(['look forward to', 'break even'])

        // 选择器路径提交新短语
        await submitPickedPhrase(window, 'piece of cake')
        const secondReply = window.locator('.message.assistant').last()
        await expect(secondReply).toContainText('1 added')
        await expect(secondReply).toContainText('piece of cake')

        // 数据库恰好新增三行、各三个字段，内容为绑定数据
        const rows = readPhraseRows(directory)
        expect(rows).toHaveLength(3)
        expect(rows.map((row) => row.phrase)).toEqual([
          'break even',
          'look forward to',
          'piece of cake'
        ])
        for (const row of rows) {
          expect(row.explantation).toContain(row.phrase)
          expect(row.example).toBe(`We will ${row.phrase} together soon.`)
        }

        // 重启后历史完整恢复：启动打开空白草稿，经侧栏打开原会话
        await app.close()
        app = await launchApp(directory)
        window = await app.firstWindow()
        await waitForReady(window)
        await openLatestConversation(window)
        await expect(window.locator('.message.user')).toHaveCount(2)
        await expect(window.locator('.message.assistant')).toHaveCount(2)
        await expect(window.locator('.message.assistant').last()).toContainText('1 added')
      } finally {
        await app.close()
      }
    })
  } finally {
    await server.close()
  }
})

test('reports unrecognized and failed phrases locally without fake data', async () => {
  const server = await startPhraseServer()
  try {
    await withTempUserData(async (directory) => {
      await writeLocalePreference(directory, 'en')
      await writeModelsConfig(directory, server.baseUrl, 'test-model')
      const app = await launchApp(directory)
      try {
        const window = await app.firstWindow()
        await waitForReady(window)
        await submitTypedPhrase(window, 'bad input')
        const reply = window.locator('.message.assistant').last()
        await expect(reply).toContainText('Processed 1 phrases')
        await expect(reply).toContainText('1 not recognizable as English phrases')
        await expect(reply).toContainText('bad input')
        expect(readPhraseRows(directory)).toEqual([])
      } finally {
        await app.close()
      }
    })
  } finally {
    await server.close()
  }
})

test('reports failed items locally when no model is configured, without a second request', async () => {
  await withTempUserData(async (directory) => {
    await writeLocalePreference(directory, 'en')
    const app = await launchApp(directory)
    try {
      const window = await app.firstWindow()
      await waitForReady(window)
      await submitTypedPhrase(window, 'look forward to')
      const reply = window.locator('.message.assistant').last()
      await expect(reply).toContainText('Processed 1 phrases')
      await expect(reply).toContainText('1 failed')
      await expect(window.getByRole('button', { name: 'Retry' })).toHaveCount(0)
    } finally {
      await app.close()
    }
  })
})

test('cancels analysis before commit and keeps the composer usable', async () => {
  const server = await startPhraseServer()
  try {
    await withTempUserData(async (directory) => {
      await writeLocalePreference(directory, 'en')
      await writeModelsConfig(directory, server.baseUrl, 'test-model')
      const app = await launchApp(directory)
      try {
        const window = await app.firstWindow()
        await waitForReady(window)
        await submitTypedPhrase(window, 'slow phrase')
        await expect.poll(() => server.phrases.includes('slow phrase')).toBe(true)
        await window.getByRole('button', { name: 'Cancel' }).click()
        await expect(window.getByText('Cancelled. You can retry.')).toBeVisible()
        await expect(window.locator('#message')).toBeEnabled()
        await expect(window.locator('.message.assistant')).toHaveCount(0)
        expect(readPhraseRows(directory)).toEqual([])

        // 取消后输入框仍可继续提交
        await submitTypedPhrase(window, 'break even')
        await expect(window.locator('.message.assistant').last()).toContainText('1 added')
      } finally {
        await app.close()
      }
    })
  } finally {
    await server.close()
  }
})
