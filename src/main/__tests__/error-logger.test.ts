import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createErrorLogger,
  installProcessErrorHandlers,
  type ErrorLogger,
  type ProcessErrorSink
} from '../error-logger'

// 可控时钟：测试按本地日期路由断言文件名，跨天用例直接推进当前时间。
function clockAt(iso: string): { now: () => Date; advanceTo(next: string): void } {
  let current = new Date(iso)
  return {
    now: () => current,
    advanceTo(next: string): void {
      current = new Date(next)
    }
  }
}

function readLines(directory: string, file: string): Array<Record<string, unknown>> {
  return readFileSync(join(directory, file), 'utf8')
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
}

let temporaryRoot = ''

beforeEach(() => {
  temporaryRoot = mkdtempSync(join(tmpdir(), 'error-logger-'))
})

afterEach(() => {
  rmSync(temporaryRoot, { recursive: true, force: true })
  vi.restoreAllMocks()
})

describe('error logger directory and per-day routing', () => {
  it('creates the logs directory on construction and appends same-day entries to one file', async () => {
    const directory = join(temporaryRoot, 'logs')
    const clock = clockAt('2026-09-18T10:00:00')
    const logger = createErrorLogger(directory, { now: clock.now })

    logger.log({ source: 'main', module: 'db', operation: 'open', message: 'first failure' })
    logger.log({ source: 'core', module: 'llm', operation: 'complete', message: 'second failure' })
    await logger.flush()

    expect(statSync(directory).isDirectory()).toBe(true)
    expect(readdirSync(directory)).toEqual(['2026-09-18.log'])
    const entries = readLines(directory, '2026-09-18.log')
    expect(entries).toHaveLength(2)
    expect(entries[0]).toMatchObject({
      level: 'error',
      source: 'main',
      module: 'db',
      operation: 'open',
      message: 'first failure'
    })
    expect(entries[1]).toMatchObject({ source: 'core', message: 'second failure' })
  })

  it('stamps each entry with a timezone-aware timestamp matching the file date', async () => {
    const directory = join(temporaryRoot, 'logs')
    const clock = clockAt('2026-09-18T23:59:30')
    const logger = createErrorLogger(directory, { now: clock.now })

    logger.log({ source: 'main', message: 'before midnight' })
    clock.advanceTo('2026-09-19T00:00:30')
    logger.log({ source: 'main', message: 'after midnight' })
    await logger.flush()

    const [before, after] = readdirSync(directory).sort()
    expect(before).toBe('2026-09-18.log')
    expect(after).toBe('2026-09-19.log')
    const timestampPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}(?:Z|[+-]\d{2}:\d{2})$/
    expect(String(readLines(directory, '2026-09-18.log')[0]['timestamp'])).toMatch(timestampPattern)
    expect(String(readLines(directory, '2026-09-19.log')[0]['timestamp'])).toMatch(timestampPattern)
  })

  it('routes queued entries by event time even when the queue drains after midnight', async () => {
    const directory = join(temporaryRoot, 'logs')
    const clock = clockAt('2026-09-18T23:59:59')
    const logger = createErrorLogger(directory, { now: clock.now })
    logger.log({ source: 'main', message: 'first' })
    logger.log({ source: 'main', message: 'queued before midnight' })
    clock.advanceTo('2026-09-19T00:00:01')
    logger.log({ source: 'main', message: 'after midnight' })
    await logger.flush()
    expect(readLines(directory, '2026-09-18.log').map((entry) => entry.message)).toEqual([
      'first',
      'queued before midnight'
    ])
    expect(readLines(directory, '2026-09-19.log').map((entry) => entry.message)).toEqual([
      'after midnight'
    ])
  })

  it('appends on restart without truncating earlier content', async () => {
    const directory = join(temporaryRoot, 'logs')
    const first = createErrorLogger(directory, { now: clockAt('2026-09-18T08:00:00').now })
    first.log({ source: 'main', message: 'from previous run' })
    await first.flush()

    const second = createErrorLogger(directory, { now: clockAt('2026-09-18T09:00:00').now })
    second.log({ source: 'main', message: 'from current run' })
    await second.flush()

    const entries = readLines(directory, '2026-09-18.log')
    expect(entries.map((entry) => entry['message'])).toEqual([
      'from previous run',
      'from current run'
    ])
  })

  it('keeps every line intact under many concurrent submissions', async () => {
    const directory = join(temporaryRoot, 'logs')
    const logger = createErrorLogger(directory, { now: clockAt('2026-09-18T12:00:00').now })
    const total = 60
    for (let i = 0; i < total; i += 1) {
      logger.log({ source: 'main', operation: 'concurrent', message: `failure ${i}` })
    }
    await logger.flush()

    const entries = readLines(directory, '2026-09-18.log')
    expect(entries).toHaveLength(total)
    expect(new Set(entries.map((entry) => entry['message']))).toHaveLength(total)
  })

  it('restricts new files to owner-only permissions where the platform supports it', async () => {
    const directory = join(temporaryRoot, 'logs')
    const logger = createErrorLogger(directory, { now: clockAt('2026-09-18T12:00:00').now })
    logger.log({ source: 'main', message: 'permission probe' })
    await logger.flush()

    if (process.platform !== 'win32') {
      expect(statSync(join(directory, '2026-09-18.log')).mode & 0o777).toBe(0o600)
    }
  })
})

describe('error logger serialization', () => {
  const now = clockAt('2026-09-18T12:00:00').now

  it('redacts registered secrets in metadata, error names and object keys', async () => {
    const directory = join(temporaryRoot, 'logs')
    const logger = createErrorLogger(directory, { now })
    const secret = 'sk-metadata-secret'
    logger.registerSecret(secret)
    const error = new Error(secret)
    Object.defineProperty(error, 'name', { value: secret })
    Object.assign(error, { [secret]: secret })
    logger.log({
      source: 'main',
      module: secret,
      operation: secret,
      code: secret,
      requestId: secret,
      message: secret,
      error,
      context: { [secret]: secret }
    })
    await logger.flush()
    const entries = readLines(directory, '2026-09-18.log')
    expect(entries).toHaveLength(1)
    expect(JSON.stringify(entries)).not.toContain(secret)
    expect(entries[0]).toMatchObject({
      module: '[REDACTED]',
      operation: '[REDACTED]',
      code: '[REDACTED]',
      requestId: '[REDACTED]',
      error: { name: '[REDACTED]' }
    })
  })

  it('serializes error name, message, stack and nested cause chain', async () => {
    const directory = join(temporaryRoot, 'logs')
    const logger = createErrorLogger(directory, { now })
    const inner = new Error('inner cause')
    const outer = new Error('outer failure', { cause: inner })

    logger.log({ source: 'core', message: 'wrapped', error: outer })
    await logger.flush()

    const entry = readLines(directory, '2026-09-18.log')[0]
    const error = entry['error'] as Record<string, unknown>
    expect(error['name']).toBe('Error')
    expect(error['message']).toBe('outer failure')
    expect(typeof error['stack']).toBe('string')
    expect((error['cause'] as Record<string, unknown>)['message']).toBe('inner cause')
  })

  it('serializes aggregate errors and non-Error thrown values', async () => {
    const directory = join(temporaryRoot, 'logs')
    const logger = createErrorLogger(directory, { now })
    const aggregate = new AggregateError(
      [new Error('part one'), new Error('part two')],
      'all failed'
    )

    logger.log({ source: 'core', message: 'aggregate', error: aggregate })
    logger.log({ source: 'core', message: 'string thrown', error: 'plain text failure' })
    logger.log({ source: 'core', message: 'object thrown', error: { reason: 'disk full' } })
    await logger.flush()

    const entries = readLines(directory, '2026-09-18.log')
    const aggregateEntry = entries[0]['error'] as Record<string, unknown>
    const parts = aggregateEntry['errors'] as Array<Record<string, unknown>>
    expect(aggregateEntry['message']).toBe('all failed')
    expect(parts.map((part) => part['message'])).toEqual(['part one', 'part two'])
    expect(entries[1]['error']).toBe('plain text failure')
    expect(entries[2]['error']).toMatchObject({ reason: 'disk full' })
  })

  it('marks circular references instead of throwing', async () => {
    const directory = join(temporaryRoot, 'logs')
    const logger = createErrorLogger(directory, { now })
    const context: Record<string, unknown> = { name: 'loop' }
    context['self'] = context

    logger.log({ source: 'main', message: 'circular', context })
    await logger.flush()

    const entry = readLines(directory, '2026-09-18.log')[0]
    expect(entry['context']).toMatchObject({ name: 'loop', self: '[Circular]' })
  })

  it('marks and truncates oversized strings, context and entries', async () => {
    const directory = join(temporaryRoot, 'logs')
    const logger = createErrorLogger(directory, { now })

    logger.log({
      source: 'main',
      message: 'x'.repeat(20_000)
    })
    logger.log({
      source: 'main',
      message: 'huge context',
      context: { parts: Array.from({ length: 40 }, (_, i) => 'y'.repeat(5000) + i) }
    })
    await logger.flush()

    const entries = readLines(directory, '2026-09-18.log')
    expect(String(entries[0]['message'])).toContain('Truncated')
    expect(String(entries[0]['message']).length).toBeLessThan(21_000)

    const context = entries[1]['context'] as Record<string, unknown>
    expect(context['truncated']).toBe(true)
    expect(entries[1]['truncated']).toBe(true)
    const rawLineSize = readFileSync(join(directory, '2026-09-18.log'), 'utf8')
      .split('\n')
      .filter((line) => line.includes('huge context'))[0].length
    expect(rawLineSize).toBeLessThanOrEqual(64 * 1024)
  })

  it('preserves level, code and requestId fields when provided', async () => {
    const directory = join(temporaryRoot, 'logs')
    const logger = createErrorLogger(directory, { now })

    logger.log({
      level: 'warn',
      source: 'main',
      module: 'ipc-guard',
      operation: 'invalid-input',
      code: 'INVALID_INPUT',
      message: 'rejected',
      requestId: 'task-7'
    })
    await logger.flush()

    expect(readLines(directory, '2026-09-18.log')[0]).toMatchObject({
      level: 'warn',
      code: 'INVALID_INPUT',
      requestId: 'task-7'
    })
  })
})

describe('error logger sanitization', () => {
  const now = clockAt('2026-09-18T12:00:00').now

  it('redacts sensitive fields in nested context objects', async () => {
    const directory = join(temporaryRoot, 'logs')
    const logger = createErrorLogger(directory, { now })

    logger.log({
      source: 'core',
      message: 'request failed',
      context: {
        headers: { Authorization: 'Bearer abc.def.ghi' },
        apiKey: 'sk-live-abcdef123456',
        nested: { access_token: 'token-value', cookie: 'session=1', keep: 'visible' }
      }
    })
    await logger.flush()

    const text = readFileSync(join(directory, '2026-09-18.log'), 'utf8')
    const context = readLines(directory, '2026-09-18.log')[0]['context'] as Record<string, unknown>
    expect(text).not.toContain('abc.def.ghi')
    expect(text).not.toContain('sk-live-abcdef123456')
    expect(text).not.toContain('token-value')
    expect(context['headers']).toBe('[REDACTED]')
    expect(context['apiKey']).toBe('[REDACTED]')
    expect(context['nested']).toMatchObject({ access_token: '[REDACTED]', keep: 'visible' })
  })

  it('redacts registered secrets inside message, stack and free text', async () => {
    const directory = join(temporaryRoot, 'logs')
    const logger = createErrorLogger(directory, { now })
    logger.registerSecret('sk-registered-secret-000')

    const error = new Error('boom')
    error.stack = `Error: boom\n    at fetch (sk-registered-secret-000 endpoint)`
    logger.log({
      source: 'core',
      message: 'call failed with sk-registered-secret-000 in message',
      error,
      context: { note: 'response mentions sk-registered-secret-000 too' }
    })
    await logger.flush()

    const text = readFileSync(join(directory, '2026-09-18.log'), 'utf8')
    expect(text).not.toContain('sk-registered-secret-000')
    const entry = readLines(directory, '2026-09-18.log')[0]
    expect(String(entry['message'])).toContain('[REDACTED]')
  })

  it('redacts bearer tokens and URL credentials in free text', async () => {
    const directory = join(temporaryRoot, 'logs')
    const logger = createErrorLogger(directory, { now })

    logger.log({
      source: 'core',
      message:
        'Authorization: Bearer eyJhbGciOi.payload.sig at https://user:secret@models.example.com/v1'
    })
    await logger.flush()

    const text = readFileSync(join(directory, '2026-09-18.log'), 'utf8')
    expect(text).not.toContain('eyJhbGciOi.payload.sig')
    expect(text).not.toContain('user:secret@')
    expect(text).toContain('Bearer [REDACTED]')
    expect(text).toContain('https://[REDACTED]@models.example.com/v1')
  })
})

describe('error logger write-failure isolation', () => {
  const now = clockAt('2026-09-18T12:00:00').now

  it('drops failed lines, reports a fixed console code without entry data, and recovers', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const directory = join(temporaryRoot, 'logs')
    const logger = createErrorLogger(directory, { now })

    // 用同名目录占据日志文件路径，让追加写入失败。
    mkdirSync(join(directory, '2026-09-18.log'))
    logger.log({ source: 'main', message: 'dropped entry with secret-value-inside' })
    logger.log({ source: 'main', message: 'another dropped entry' })
    await logger.flush()

    expect(console.error).toHaveBeenCalled()
    const consoleOutput = JSON.stringify((console.error as ReturnType<typeof vi.fn>).mock.calls)
    expect(consoleOutput).toContain('WRITE_FAILED')
    expect(consoleOutput).not.toContain('dropped entry')
    // 自身失败诊断限频：同一窗口内多次失败只输出一次。
    expect(console.error).toHaveBeenCalledTimes(1)

    rmSync(join(directory, '2026-09-18.log'), { recursive: true, force: true })
    logger.log({ source: 'main', message: 'recovered entry' })
    await logger.flush()

    expect(readLines(directory, '2026-09-18.log').map((entry) => entry['message'])).toEqual([
      'recovered entry'
    ])
  })

  it('never throws from log() and keeps flush bounded when writes keep failing', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const directory = join(temporaryRoot, 'logs')
    const logger = createErrorLogger(directory, { now })
    mkdirSync(join(directory, '2026-09-18.log'))

    expect(() =>
      logger.log({ source: 'main', message: 'still failing', error: new Error('origin') })
    ).not.toThrow()
    await expect(logger.flush(50)).resolves.toBeUndefined()
  })
})

describe('error logger synchronous fatal path', () => {
  it('writes synchronously without awaiting flush', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const directory = join(temporaryRoot, 'logs')
    const logger = createErrorLogger(directory, { now: clockAt('2026-09-18T12:00:00').now })

    logger.logSync({
      source: 'main',
      module: 'process',
      message: 'fatal',
      error: new Error('fatal origin')
    })

    const entries = readLines(directory, '2026-09-18.log')
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ module: 'process', message: 'fatal' })
  })
})

describe('process error handlers', () => {
  class FakeProcess extends EventEmitter implements ProcessErrorSink {}

  function loggerWithHandlers(): {
    logger: ErrorLogger
    target: FakeProcess
    exit: ReturnType<typeof vi.fn>
  } {
    const fakeProcess = new FakeProcess()
    const exit = vi.fn()
    const logger = createErrorLogger(join(temporaryRoot, 'logs'), {
      now: clockAt('2026-09-18T12:00:00').now
    })
    installProcessErrorHandlers(logger, { process: fakeProcess, exit })
    return { logger, target: fakeProcess, exit }
  }

  it('logs uncaught exceptions synchronously and exits non-zero', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const { target, exit } = loggerWithHandlers()

    target.emit('uncaughtException', new Error('uncaught boom'))

    expect(exit).toHaveBeenCalledWith(1)
    const entries = readLines(join(temporaryRoot, 'logs'), '2026-09-18.log')
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({
      source: 'main',
      module: 'process',
      operation: 'uncaughtException',
      message: expect.stringContaining('uncaught boom')
    })
  })

  it('logs unhandled rejections without exiting', async () => {
    const { target, exit, logger } = loggerWithHandlers()

    target.emit('unhandledRejection', new Error('rejected boom'), Promise.resolve())
    await logger.flush()

    expect(exit).not.toHaveBeenCalled()
    const entries = readLines(join(temporaryRoot, 'logs'), '2026-09-18.log')
    expect(entries[0]).toMatchObject({
      source: 'main',
      operation: 'unhandledRejection',
      message: expect.stringContaining('rejected boom')
    })
  })

  it('does not register duplicate listeners for the same logger', () => {
    const fakeProcess = new FakeProcess()
    const logger = createErrorLogger(join(temporaryRoot, 'logs'), {
      now: clockAt('2026-09-18T12:00:00').now
    })
    installProcessErrorHandlers(logger, { process: fakeProcess, exit: () => {} })
    const uncaughtCount = fakeProcess.listenerCount('uncaughtException')
    const rejectionCount = fakeProcess.listenerCount('unhandledRejection')

    installProcessErrorHandlers(logger, { process: fakeProcess, exit: () => {} })

    expect(fakeProcess.listenerCount('uncaughtException')).toBe(uncaughtCount)
    expect(fakeProcess.listenerCount('unhandledRejection')).toBe(rejectionCount)
  })
})
