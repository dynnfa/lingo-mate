import { createServer } from 'node:http'
import { AddressInfo } from 'node:net'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  _electron as electron,
  expect,
  type ElectronApplication,
  type Page
} from '@playwright/test'

export interface LaunchOptions {
  // 默认使用显式本地模拟模型（LINGO_MATE_MODEL=local）让既有会话用例与真实配置解耦；
  // models 用例传 'remote' 走真实远程适配器。
  model?: 'local' | 'remote'
}

export async function launchApp(
  userDataPath: string,
  options: LaunchOptions = {}
): Promise<ElectronApplication> {
  return electron.launch({
    args: [process.cwd(), `--user-data-dir=${userDataPath}`],
    env: { ...process.env, LINGO_MATE_MODEL: options.model ?? 'local' }
  })
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

// 预写版本 2 的模型配置集合，指向本地假服务（回环 HTTP 允许）。
// configId 必须是 UUID；记录写为当前使用的模型。
export async function writeModelsConfig(
  userDataPath: string,
  baseUrl: string,
  modelId: string
): Promise<void> {
  await writeFile(
    join(userDataPath, 'models.json'),
    JSON.stringify({
      schemaVersion: 2,
      activeConfigId: 'e2e00000-0000-4000-8000-000000000001',
      configs: [
        {
          id: 'e2e00000-0000-4000-8000-000000000001',
          protocol: 'openai-compatible',
          baseUrl,
          modelId
        }
      ]
    })
  )
}

export interface FakeModelServer {
  baseUrl: string
  close(): Promise<void>
}

// OpenAI 兼容假服务：流式分片返回固定回复，供真实远程适配器端到端验证。
export async function startFakeModelServer(): Promise<FakeModelServer> {
  const server = createServer((req, res) => {
    void (async () => {
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(chunk as Buffer)
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
        stream?: boolean
      }
      if (!body.stream) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(
          JSON.stringify({
            id: 'chatcmpl-e2e',
            object: 'chat.completion',
            choices: [
              { index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }
            ]
          })
        )
        return
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      for (const delta of ['你好', '，', '这是假模型', '的流式回复。']) {
        res.write(
          `data: ${JSON.stringify({
            id: 'chatcmpl-e2e',
            object: 'chat.completion.chunk',
            choices: [{ index: 0, delta: { content: delta }, finish_reason: null }]
          })}\n\n`
        )
        await new Promise((resolve) => setTimeout(resolve, 150))
      }
      res.write(
        `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`
      )
      res.write('data: [DONE]\n\n')
      res.end()
    })()
  })
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve)
  })
  const { port } = server.address() as AddressInfo
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve()))
  }
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
