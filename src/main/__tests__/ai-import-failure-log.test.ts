import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { createErrorLogger } from '../error-logger'
import { createAiImportFailureDiagnostic } from '../ai-import-failure-log'

it('routes ai import failures into the shared daily log with credentials redacted', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'ai-import-log-'))
  try {
    const logger = createErrorLogger(directory, {
      now: () => new Date('2026-09-18T10:00:00')
    })
    const log = createAiImportFailureDiagnostic(logger)
    log(
      {
        term: 'protest',
        modelId: 'fixture',
        promptVersion: 'v3',
        code: 'INVALID_ANALYSIS',
        stage: 'protocol',
        reason: 'Expected one function tool call',
        issues: [{ path: ['choices', 0], code: 'invalid_type', message: 'expected tool call' }],
        response: {
          choices: [{ message: { content: 'returned text secret-key' } }],
          headers: { Authorization: 'Bearer secret-key' }
        }
      },
      'secret-key'
    )
    await logger.flush()

    // 只写公共按天文件，不再产生独立的 ai-import-errors.log。
    expect(readdirSync(directory)).toEqual(['2026-09-18.log'])
    expect(existsSync(join(directory, 'ai-import-errors.log'))).toBe(false)

    const text = readFileSync(join(directory, '2026-09-18.log'), 'utf8')
    const entry = JSON.parse(text) as Record<string, unknown>
    expect(entry).toMatchObject({
      source: 'core',
      module: 'ai-import',
      operation: 'analyze',
      code: 'INVALID_ANALYSIS'
    })
    const context = entry['context'] as Record<string, unknown>
    expect(context['term']).toBe('protest')
    expect(context['promptVersion']).toBe('v3')
    expect(context['response']).toMatchObject({
      choices: [{ message: { content: 'returned text [REDACTED]' } }],
      headers: '[REDACTED]'
    })
    expect(text).not.toContain('secret-key')
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
