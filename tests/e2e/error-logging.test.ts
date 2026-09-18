import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, launchApp, test, waitForReady, withTempUserData } from './helpers'

// 端到端验证统一错误日志：启动即在 <userData>/logs 建目录；Renderer 全局
// 异常经受限上报通道进入 Main 并落盘为按天 JSONL；Renderer 无法读取日志。
test('collects renderer errors into the per-day local log', async () => {
  await withTempUserData(async (userDataPath) => {
    const electronApp = await launchApp(userDataPath)
    try {
      const window = await electronApp.firstWindow()
      await waitForReady(window)

      const logsDirectory = join(userDataPath, 'logs')
      expect(existsSync(logsDirectory)).toBe(true)

      // 触发 Renderer 全局异常：监听器应通过 window.api.reportError 上报。
      await window.evaluate(() => {
        window.dispatchEvent(
          new ErrorEvent('error', {
            error: new Error('e2e-renderer-boom'),
            message: 'e2e-renderer-boom'
          })
        )
      })

      await expect
        .poll(
          async () => {
            const files = existsSync(logsDirectory) ? readdirSync(logsDirectory) : []
            if (files.length === 0) return null
            return readFileSync(join(logsDirectory, files[0]), 'utf8')
          },
          { timeout: 10_000 }
        )
        .toContain('e2e-renderer-boom')

      // 每一行都是可解析 JSON，且 Renderer 来源被正确标记。
      const files = readdirSync(logsDirectory)
      expect(files).toHaveLength(1)
      expect(files[0]).toMatch(/^\d{4}-\d{2}-\d{2}\.log$/)
      const lines = readFileSync(join(logsDirectory, files[0]), 'utf8')
        .split('\n')
        .filter((line) => line.length > 0)
      expect(lines.length).toBeGreaterThan(0)
      const reported = lines
        .map((line) => JSON.parse(line) as Record<string, unknown>)
        .find((entry) => entry['message'] === 'e2e-renderer-boom')
      expect(reported).toMatchObject({ source: 'renderer', module: 'global' })

      // 日志读取能力不暴露给 Renderer：window.api 只含受限错误上报入口。
      const apiKeys = await window.evaluate(() =>
        Object.keys((globalThis as typeof globalThis & { api?: object }).api ?? {}).sort()
      )
      expect(apiKeys).not.toContain('readLogs')
      expect(apiKeys).not.toContain('logs')
    } finally {
      await electronApp.close()
    }
  })
})

test('counts oversized renderer reports against the rate limit', async () => {
  await withTempUserData(async (userDataPath) => {
    const electronApp = await launchApp(userDataPath)
    try {
      const window = await electronApp.firstWindow()
      await waitForReady(window)
      const codes = await window.evaluate(async () => {
        const codes: string[] = []
        for (let i = 0; i < 45; i += 1) {
          const result = await globalThis.window.api.reportError({
            source: 'renderer',
            message: 'oversized report',
            context: { blob: 'x'.repeat(20 * 1024) }
          })
          if (result.status === 'error') codes.push(result.error.code)
        }
        return codes
      })
      expect(codes.filter((code) => code === 'PAYLOAD_TOO_LARGE')).toHaveLength(30)
      expect(codes.filter((code) => code === 'RATE_LIMITED')).toHaveLength(15)
    } finally {
      await electronApp.close()
    }
    const directory = join(userDataPath, 'logs')
    const entries = readdirSync(directory)
      .flatMap((file) =>
        readFileSync(join(directory, file), 'utf8')
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line) as { operation?: string; context?: { channel?: string } })
      )
      .filter((entry) => entry.context?.channel === 'error-log:report')
    expect(entries).toHaveLength(1)
    expect(entries.filter((entry) => entry.operation === 'rate-limit')).toHaveLength(1)
  })
})
