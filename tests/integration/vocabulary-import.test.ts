import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openDatabase } from '../../src/database/database'
import { SqliteVocabularyRepository } from '../../src/database/sqlite-vocabulary-repository'
import { SqliteLlmUsageRepository } from '../../src/database/sqlite-llm-usage-repository'
import { VocabularyModule } from '../../src/core/learning/vocabulary/vocabulary-module'
import { LlmVocabularyAnalyzer } from '../../src/core/llm/llm-vocabulary-analyzer'
import { LlmClient, type CreateLlmClient } from '../../src/core/llm/llm-client'
import { LlmUsageRecorder } from '../../src/core/llm/llm-usage-recorder'
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
      // 与生产相同的组装方式：统一客户端自动落账，业务层不管理记账。
      const usageRepository = new SqliteLlmUsageRepository(database)
      const createClient: CreateLlmClient = (config) =>
        new LlmClient(config, new LlmUsageRecorder(usageRepository))
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
            wordMs,
            createClient
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

      // 逐词真实调用各落一行：本地去重、SQL 写入和结果格式化不产生记录。
      // 重复词 apple 不发起请求；invalid/bad 通信 completed 但业务失败。
      let usage = usageRepository.list({})
      expect(usage).toHaveLength(5)
      expect(usage.every((row) => row.modelId === 'test-model')).toBe(true)
      const failedRows = usage.filter((row) => row.status === 'failed')
      expect(failedRows).toHaveLength(1)
      expect(failedRows[0].errorCode).toBe('UNKNOWN')
      expect(failedRows[0].responseModelId).toBeNull()
      expect(failedRows[0].inputTokens).toBeNull()
      for (const row of usage.filter((r) => r.status === 'completed')) {
        expect(row).toMatchObject({
          responseModelId: 'fixture-model',
          inputTokens: 100,
          outputTokens: 20,
          totalTokens: 120,
          usageStatus: 'reported'
        })
      }

      const again = await module.addBatch(
        { requestId: randomUUID(), text: 'apple,banana', wordLanguage: 'en' },
        'en'
      )
      expect(again.counts.existing).toBe(2)
      expect(server.terms).toHaveLength(5)
      // 取消批次前只有 5 次逐词 tool call 请求，不存在任何结果描述请求。
      expect(server.requests).toHaveLength(5)
      // 命中词库跳过分析：不产生新的真实请求记录。
      expect(usageRepository.list({})).toHaveLength(5)
      const requestId = randomUUID()
      const pending = module.addBatch({ requestId, text: 'slow,orange', wordLanguage: 'en' }, 'en')
      await new Promise((resolve) => setTimeout(resolve, 40))
      module.cancel(requestId)
      expect((await pending).outcome).toBe('cancelled')
      expect(server.requests).toHaveLength(7)
      expect(repository.list({}).entries).toHaveLength(2)

      // 取消批次：在途调用记 cancelled、用量未知不写 0；每个调用至多一个终态。
      usage = usageRepository.list({})
      expect(usage).toHaveLength(7)
      const cancelledRows = usage.filter((row) => row.status === 'cancelled')
      expect(cancelledRows.length).toBeGreaterThanOrEqual(1)
      for (const row of cancelledRows) {
        expect(row.inputTokens).toBeNull()
        expect(row.usageStatus).toBe('missing')
      }

      // 请求使用工具协议，且没有旧的 response_format。
      const first = server.requests[0]
      expect(first.messages[0].content).toContain('Simplified Chinese (zh-CN)')
      expect(first.tools?.map((tool) => tool.function.name).sort()).toEqual([
        'insert_vocabulary',
        'vocabulary_unrecognized'
      ])
      expect(first.tool_choice).toBe('auto')
      expect(first.parallel_tool_calls).toBeUndefined()
      expect(first.tools?.every((tool) => !('strict' in tool.function))).toBe(true)
      expect(first.response_format).toBeUndefined()
    } finally {
      database.close()
    }
  })
})
