import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { createErrorLogger } from '../error-logger'
import { createLlmClientFactory } from '../llm-client-factory'
import type { LlmUsageRecorder } from '../../core/llm/llm-usage-recorder'

const { constructed } = vi.hoisted(() => ({ constructed: vi.fn() }))
vi.mock('../../core/llm/llm-client', () => ({
  LlmClient: class {
    constructor(config: unknown) {
      constructed(config)
    }
  }
}))

it('registers every snapshot before client construction and retains replaced keys', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'client-secrets-'))
  try {
    const logger = createErrorLogger(directory)
    const factory = createLlmClientFactory(logger, {} as LlmUsageRecorder)
    constructed.mockImplementation((config: { apiKey: string }) => {
      logger.log({ source: 'main', message: config.apiKey })
    })
    factory({ baseUrl: 'https://example.test', apiKey: 'old-fake-key' })
    factory({ baseUrl: 'https://example.test', apiKey: 'new-fake-key' })
    logger.log({ source: 'core', message: 'in flight: old-fake-key new-fake-key' })
    await logger.flush()
    const content = readFileSync(join(directory, readdirSync(directory)[0]), 'utf8')
    expect(content.trim().split('\n')).toHaveLength(3)
    expect(content).not.toContain('old-fake-key')
    expect(content).not.toContain('new-fake-key')
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
