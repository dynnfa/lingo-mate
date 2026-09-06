import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  _electron as electron,
  expect,
  type ElectronApplication,
  type Page
} from '@playwright/test'

export async function launchApp(userDataPath: string): Promise<ElectronApplication> {
  return electron.launch({ args: [process.cwd(), `--user-data-dir=${userDataPath}`] })
}

export async function withTempUserData(
  run: (userDataPath: string) => Promise<void>,
  prefix = 'lingo-mate-'
): Promise<void> {
  const userDataPath = await mkdtemp(join(tmpdir(), prefix))
  try {
    await run(userDataPath)
  } finally {
    await rm(userDataPath, { force: true, recursive: true })
  }
}

// 测试语言显式固定：向临时 userData 预写 electron-store 偏好文件，
// 不依赖开发机系统语言，也不在断言前额外切换 UI。
export async function writeLocalePreference(
  userDataPath: string,
  preference: 'system' | 'zh-CN' | 'en'
): Promise<void> {
  await writeFile(
    join(userDataPath, 'preferences.json'),
    JSON.stringify({ localePreference: preference })
  )
}

export async function waitForReady(window: Page): Promise<void> {
  await window.waitForSelector('main[data-phase="ready"]')
}

// 通过设置页切换语言：页面内语言名称固定，不依赖当前界面语言；
// 等待 document.lang 更新后再返回，确保保存已完成。
export async function switchLanguage(
  window: Page,
  label: string,
  expectedLang: 'zh-CN' | 'en'
): Promise<void> {
  await window.click('.settings-button')
  const settingsPage = window.locator('main.settings-page')
  await expect(settingsPage).toBeVisible()
  await window.getByRole('radio', { name: label }).check()
  await window.waitForFunction((lang) => document.documentElement.lang === lang, expectedLang, {
    timeout: 10_000
  })
  await window.click('.settings-back-button')
  await expect(settingsPage).toBeHidden()
}

export { expect, test } from '@playwright/test'
