import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { createAiImportFailureDiagnostic } from '../../src/main/ai-import-failure-log'
import {
  createCoreDiagnostics,
  createErrorLogger,
  createIpcGuardDiagnostics
} from '../../src/main/error-logger'
import { createTrustedHandlerRegistrar } from '../../src/main/ipc-guard'
import { FakeSender, registeredHandler } from '../../src/main/__tests__/helpers/ipc-test-env'

vi.mock('electron', async () =>
  (await import('../../src/main/__tests__/helpers/ipc-test-env')).electronTestModule()
)

describe('unified error log across modules', () => {
  it('collects ipc guard, core diagnostics and ai import failures in one daily file', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'error-log-integration-'))
    try {
      const logger = createErrorLogger(directory, {
        now: () => new Date('2026-09-18T15:30:00')
      })
      const sender = new FakeSender()

      // 1) IPC 守卫：handler 异常在映射为安全错误前先落盘原始原因。
      const register = createTrustedHandlerRegistrar(
        { rendererUrl: 'file:///app/renderer/index.html' },
        createIpcGuardDiagnostics(logger)
      )
      const resultSchema = z.discriminatedUnion('status', [
        z.object({ status: z.literal('ok') }),
        z.object({
          status: z.literal('error'),
          error: z.object({ code: z.enum(['UNTRUSTED_SOURCE', 'UNKNOWN_ERROR']) })
        })
      ])
      const original = new Error('disk exploded while saving')
      register({
        channel: 'integration:probe',
        inputSchema: z.undefined(),
        resultSchema,
        invalidInputError: () => ({ code: 'UNKNOWN_ERROR' }),
        mapError: () => ({ code: 'UNKNOWN_ERROR' }),
        fallbackError: { code: 'UNKNOWN_ERROR' },
        handler: () => {
          throw original
        }
      })
      const guardResult = registeredHandler('integration:probe')({ sender }, undefined)
      expect(guardResult).toEqual({ status: 'error', error: { code: 'UNKNOWN_ERROR' } })

      // 2) Core 诊断：synonym 式脱敏 cause 链。
      createCoreDiagnostics(logger).report({
        module: 'synonym',
        operation: 'word',
        code: 'MODEL_ERROR',
        message: 'synonym word analysis failed',
        context: { chain: [{ type: 'SynonymError', code: 'MODEL_ERROR' }] }
      })

      // 3) AI 导入失败适配器。
      createAiImportFailureDiagnostic(logger)(
        {
          term: 'protest',
          modelId: 'fixture',
          promptVersion: 'v3',
          code: 'MODEL_ERROR',
          stage: 'request',
          issues: [],
          response: null
        },
        'sk-integration-secret'
      )

      await logger.flush()

      expect(existsSync(join(directory, '2026-09-18.log'))).toBe(true)
      const entries = readFileSync(join(directory, '2026-09-18.log'), 'utf8')
        .split('\n')
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as Record<string, unknown>)

      expect(entries).toHaveLength(3)
      expect(entries.map((entry) => entry['source'])).toEqual(['main', 'core', 'core'])
      // 守卫条目保留原始异常的 message/stack，而不是映射后的安全码。
      const guardEntry = entries[0]
      expect(guardEntry).toMatchObject({
        module: 'ipc-guard',
        operation: 'handler',
        message: expect.stringContaining('integration:probe')
      })
      const guardError = guardEntry['error'] as Record<string, unknown>
      expect(guardError['message']).toBe('disk exploded while saving')
      expect(typeof guardError['stack']).toBe('string')
      expect(entries[1]).toMatchObject({ module: 'synonym', code: 'MODEL_ERROR' })
      expect(entries[2]).toMatchObject({ module: 'ai-import', code: 'MODEL_ERROR' })
      // 已登记密钥在后续所有条目中都被脱敏（含 AI 导入的 context）。
      const text = JSON.stringify(entries)
      expect(text).not.toContain('sk-integration-secret')
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
