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
  it('executes valid tool-call inserts, rejects bad responses, skips duplicates and never persists cancellation', async () => {
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
      const entries = repository.list({}).entries
      expect(entries).toHaveLength(2)
      expect(entries.map((entry) => entry.term).sort()).toEqual(['apple', 'banana'])
      expect(entries[0]).toMatchObject({
        phonetic: expect.stringMatching(/^\/.+\/$/),
        meaning: expect.stringContaining('水果'),
        exampleSentences: [expect.stringContaining('after lunch')]
      })
      expect(server.terms.filter((term) => term === 'apple')).toHaveLength(1)
      const again = await module.addBatch(
        { requestId: randomUUID(), text: 'apple,banana', wordLanguage: 'en' },
        'en'
      )
      expect(again.counts.existing).toBe(2)
      expect(server.terms).toHaveLength(5)
      // 取消批次前只有 5 次逐词 tool call 请求，不存在任何结果描述请求。
      expect(server.requests).toHaveLength(5)
      const requestId = randomUUID()
      const pending = module.addBatch({ requestId, text: 'slow,orange', wordLanguage: 'en' }, 'en')
      await new Promise((resolve) => setTimeout(resolve, 40))
      module.cancel(requestId)
      expect((await pending).outcome).toBe('cancelled')
      expect(server.requests).toHaveLength(7)
      expect(repository.list({}).entries).toHaveLength(2)

      // 请求使用工具协议，且没有旧的 response_format。
      const first = server.requests[0]
      expect(first.messages[0].content).toContain('Simplified Chinese (zh-CN)')
      expect(first.tools?.map((tool) => tool.function.name).sort()).toEqual([
        'insert_vocabulary',
        'vocabulary_unrecognized'
      ])
      expect(first.tool_choice).toBe('required')
      expect(first.parallel_tool_calls).toBeUndefined()
      expect(first.tools?.every((tool) => !('strict' in tool.function))).toBe(true)
      expect(first.response_format).toBeUndefined()
    } finally {
      database.close()
    }
  })
})
