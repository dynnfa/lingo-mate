import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ErrorLogger } from '../error-logger'
import { createErrorLogger, createIpcGuardDiagnostics } from '../error-logger'
import { registerErrorReportIpc } from '../error-log-ipc'
import { createTrustedHandlerRegistrar } from '../ipc-guard'
import { ERROR_LOG_CHANNELS } from '../../shared/error-report'
import { FakeSender, registeredHandler, resetIpcMocks } from './helpers/ipc-test-env'

vi.mock('electron', async () => (await import('./helpers/ipc-test-env')).electronTestModule())

const NOW = new Date('2026-09-18T12:00:00')

let temporaryRoot = ''
let logger: ErrorLogger
let currentTime: number

beforeEach(() => {
  resetIpcMocks()
  currentTime = NOW.getTime()
  temporaryRoot = mkdtempSync(join(tmpdir(), 'error-log-ipc-'))
  logger = createErrorLogger(join(temporaryRoot, 'logs'), { now: () => NOW })
  const register = createTrustedHandlerRegistrar(
    {
      rendererUrl: 'file:///app/renderer/index.html'
    },
    createIpcGuardDiagnostics(logger)
  )
  registerErrorReportIpc(logger, register, {
    maxReports: 3,
    windowMs: 10_000,
    now: () => currentTime
  })
})

afterEach(async () => {
  await logger.flush()
  rmSync(temporaryRoot, { recursive: true, force: true })
})

function report(input: unknown, sender: FakeSender = new FakeSender()): unknown {
  return registeredHandler(ERROR_LOG_CHANNELS.report)(
    { sender, senderFrame: sender.mainFrame },
    input
  )
}

async function readEntries(): Promise<Array<Record<string, unknown>>> {
  await logger.flush()
  const file = join(temporaryRoot, 'logs', '2026-09-18.log')
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
}

describe('error report ipc', () => {
  it('accepts a valid report and writes it with main-side timestamp and payload source', async () => {
    const result = report({
      source: 'renderer',
      module: 'react',
      operation: 'error-boundary',
      message: 'component crashed',
      stack: 'Error: component crashed\n    at App',
      context: { view: 'settings' }
    })

    expect(result).toEqual({ status: 'ok' })
    const entries = await readEntries()
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({
      source: 'renderer',
      module: 'react',
      operation: 'error-boundary',
      message: 'component crashed',
      // 时间戳由 Main 生成；前缀与本地日期口径一致，正则覆盖任意时区。
      timestamp: expect.stringMatching(/^2026-09-18T12:00:00\.000(?:Z|[+-]\d{2}:\d{2})$/)
    })
    expect((entries[0]['error'] as Record<string, unknown>)['stack']).toContain('component crashed')
  })

  it('rejects schema-invalid reports and logs only safe metadata', async () => {
    const result = report({ source: 'main', message: 'spoofed source' })
    expect(result).toEqual({ status: 'error', error: { code: 'INVALID_REPORT' } })
    expect(await readEntries()).toMatchObject([{ level: 'warn', operation: 'invalid-input' }])
  })

  it('rejects oversized payloads before serialization', async () => {
    const result = report({
      source: 'renderer',
      message: 'big context',
      context: { blob: 'z'.repeat(20 * 1024) }
    })
    expect(result).toEqual({ status: 'error', error: { code: 'PAYLOAD_TOO_LARGE' } })
    expect(await readEntries()).toHaveLength(0)
  })

  it('rate-limits bursts per sender and logs one warn with safe metadata', async () => {
    const sender = new FakeSender()
    for (let i = 0; i < 3; i += 1) {
      expect(report({ source: 'renderer', message: `failure ${i}` }, sender)).toEqual({
        status: 'ok'
      })
    }
    expect(report({ source: 'renderer', message: 'one too many' }, sender)).toEqual({
      status: 'error',
      error: { code: 'RATE_LIMITED' }
    })

    const entries = await readEntries()
    // 3 条正常上报 + 1 条限频 warn；warn 不包含被丢弃报告的内容。
    expect(entries).toHaveLength(4)
    const warn = entries[3]
    expect(warn).toMatchObject({ level: 'warn', code: 'RATE_LIMITED' })
    const text = JSON.stringify(entries)
    expect(text).not.toContain('one too many')
  })

  it('counts invalid reports against the same budget before validation diagnostics', async () => {
    const sender = new FakeSender()
    for (let i = 0; i < 50; i += 1) {
      report({ source: 'renderer', message: 'x'.repeat(2001) }, sender)
    }
    expect(report({ source: 'renderer', message: 'valid but over budget' }, sender)).toEqual({
      status: 'error',
      error: { code: 'RATE_LIMITED' }
    })
    const entries = await readEntries()
    expect(entries).toHaveLength(4)
    expect(entries.filter((entry) => entry.operation === 'invalid-input')).toHaveLength(3)
    expect(entries.filter((entry) => entry.code === 'RATE_LIMITED')).toHaveLength(1)
    expect(JSON.stringify(entries)).not.toContain('x'.repeat(100))
  })

  it('bounds untrusted-source diagnostics and restores the budget after the window', async () => {
    const sender = new FakeSender()
    sender.owned = false
    for (let i = 0; i < 50; i += 1) {
      expect(report({ source: 'renderer', message: 'untrusted' }, sender)).toMatchObject({
        status: 'error',
        error: { code: 'UNTRUSTED_SOURCE' }
      })
    }
    expect(await readEntries()).toHaveLength(4)
    currentTime += 10_000
    sender.owned = true
    expect(report({ source: 'renderer', message: 'recovered' }, sender)).toEqual({ status: 'ok' })
    expect(await readEntries()).toHaveLength(5)
  })

  it('tracks rate limits per sender', () => {
    const senderA = new FakeSender()
    const senderB = new (class extends FakeSender {
      readonly id = 8
    })()
    for (let i = 0; i < 3; i += 1) {
      expect(report({ source: 'renderer', message: `a-${i}` }, senderA)).toEqual({ status: 'ok' })
    }
    expect(report({ source: 'renderer', message: 'a-excess' }, senderA)).toMatchObject({
      status: 'error'
    })
    expect(report({ source: 'renderer', message: 'b-fresh' }, senderB)).toEqual({ status: 'ok' })
  })

  it('keeps the channel healthy when the logger itself throws', () => {
    const explodingLogger: ErrorLogger = {
      directory: '/tmp/unused',
      registerSecret: () => {},
      log: () => {
        throw new Error('logger exploded')
      },
      logSync: () => {},
      flush: () => Promise.resolve()
    }
    const register = createTrustedHandlerRegistrar({
      rendererUrl: 'file:///app/renderer/index.html'
    })
    registerErrorReportIpc(explodingLogger, register, {
      maxReports: 100,
      windowMs: 10_000,
      now: () => 0
    })

    expect(report({ source: 'renderer', message: 'still accepted' })).toEqual({ status: 'ok' })
  })
})
