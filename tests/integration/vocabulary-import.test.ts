import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openDatabase } from '../../src/database/database'
import { SqliteVocabularyRepository } from '../../src/database/sqlite-vocabulary-repository'
import { VocabularyModule } from '../../src/core/learning/vocabulary/vocabulary-module'
import { LlmVocabularyAnalyzer } from '../../src/core/llm/llm-vocabulary-analyzer'
import { startVocabularyServer, type VocabularyServer } from './fixtures/vocabulary-server'

let server: VocabularyServer
beforeAll(async () => {
  server = await startVocabularyServer()
})
afterAll(async () => {
  await server?.close()
})
describe('real HTTP adapter → batch → SQLite integration', () => {
  it('saves valid analyses, rejects bad responses, skips duplicates and never persists cancellation', async () => {
    const database = openDatabase(':memory:')
    try {
      const repository = new SqliteVocabularyRepository(database)
      const module = new VocabularyModule(
        repository,
        (wordMs) =>
          new LlmVocabularyAnalyzer(
            {
              configured: true,
              protocol: 'openai-compatible',
              baseUrl: server.baseUrl,
              modelId: 'test-model',
              apiKey: undefined
            },
            wordMs
          )
      )
      const result = await module.addBatch(
        {
          requestId: randomUUID(),
          text: 'apple, banana, apple, invalid, bad, service-error',
          wordLanguage: 'en'
        },
        'zh-CN'
      )
      expect(result.counts).toEqual({ total: 6, saved: 2, existing: 0, duplicate: 1, failed: 3 })
      expect(repository.list({}).entries).toHaveLength(2)
      expect(server.terms.filter((term) => term === 'apple')).toHaveLength(1)
      const again = await module.addBatch(
        { requestId: randomUUID(), text: 'apple,banana', wordLanguage: 'en' },
        'en'
      )
      expect(again.counts.existing).toBe(2)
      expect(server.terms).toHaveLength(5)
      const requestId = randomUUID()
      const pending = module.addBatch({ requestId, text: 'slow,orange', wordLanguage: 'en' }, 'en')
      await new Promise((resolve) => setTimeout(resolve, 40))
      module.cancel(requestId)
      expect((await pending).outcome).toBe('cancelled')
      expect(repository.list({}).entries).toHaveLength(2)
      expect(server.requests[0].messages[0].content).toContain('Simplified Chinese (zh-CN)')
      expect(server.requests[0].response_format).toMatchObject({
        type: 'json_schema',
        json_schema: { strict: true }
      })
    } finally {
      database.close()
    }
  })
})
