import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { openDatabase } from '../../src/database/database'
import { SqliteVocabularyRepository } from '../../src/database/sqlite-vocabulary-repository'
import { VocabularyModule } from '../../src/core/learning/vocabulary/vocabulary-module'
import { LlmVocabularyAnalyzer } from '../../src/core/llm/llm-vocabulary-analyzer'
import { LlmClient, type CreateLlmClient } from '../../src/core/llm/llm-client'
import { LlmUsageRecorder } from '../../src/core/llm/llm-usage-recorder'

afterEach(() => vi.unstubAllGlobals())

const createClient: CreateLlmClient = (config) =>
  new LlmClient(
    config,
    new LlmUsageRecorder({
      insertStarted: () => {},
      finish: () => {},
      markInterruptedStarted: () => 0,
      list: () => []
    })
  )

describe.each(['tool', 'text', 'sql'] as const)(
  'vocabulary with DeepSeek V4: %s response',
  (responseKind) => {
    it.each([
      ['https://api.deepseek.com/v1', 'deepseek-v4-flash', true],
      ['https://api.deepseek.com', 'deepseek-v4-pro', true],
      ['https://api.deepseek.com/beta', 'deepseek-v4-flash', true],
      ['https://api.deepseek.com/v1', 'deepseek-chat', false],
      ['https://model.invalid/v1', 'deepseek-v4-flash', false],
      ['https://api.deepseek.com.model.invalid/v1', 'deepseek-v4-flash', false]
    ] as const)(
      '%s / %s validates the result before saving',
      async (baseUrl, modelId, useThinking) => {
        // Replay the observed provider restriction at the HTTP boundary, using the real SDK.
        const fetchMock = vi.fn(async (_url: unknown, init: RequestInit) => {
          const body = JSON.parse(String(init.body)) as {
            tool_choice?: string
            thinking?: { type: string }
            reasoning_effort?: string
            stream?: boolean
            tools?: unknown[]
          }
          if (
            useThinking &&
            body.tool_choice === 'required' &&
            body.thinking?.type !== 'disabled'
          ) {
            return Response.json(
              {
                error: {
                  message: 'Thinking mode does not support this tool_choice',
                  type: 'invalid_request_error'
                }
              },
              { status: 400 }
            )
          }
          expect(body.tool_choice).toBe('auto')
          expect(body.thinking).toEqual(useThinking ? { type: 'enabled' } : undefined)
          expect(body.reasoning_effort).toBe(useThinking ? 'high' : undefined)
          expect(body.stream).toBe(false)
          expect(body.tools).toHaveLength(2)
          expect(JSON.stringify(body.tools)).not.toContain('INSERT INTO')
          expect(JSON.stringify(body.tools)).not.toContain('"sql"')
          if (responseKind === 'text') {
            return Response.json({
              choices: [
                { finish_reason: 'stop', message: { role: 'assistant', content: 'Saved apple.' } }
              ]
            })
          }
          return Response.json({
            choices: [
              {
                index: 0,
                finish_reason: 'tool_calls',
                message: {
                  role: 'assistant',
                  content: null,
                  ...(useThinking ? { reasoning_content: 'Synthetic reasoning fixture.' } : {}),
                  tool_calls: [
                    {
                      id: 'call_1',
                      type: 'function',
                      function: {
                        name: 'insert_vocabulary',
                        arguments: JSON.stringify({
                          ...(responseKind === 'sql' ? { sql: 'DELETE FROM vocabulary' } : {}),
                          term: 'apple',
                          phonetic: ['/ˈæpəl/'],
                          meaning: 'A round fruit.',
                          concept: 'A fruit eaten as food.',
                          example_sentences: ['I ate an apple.']
                        })
                      }
                    }
                  ]
                }
              }
            ]
          })
        })
        vi.stubGlobal('fetch', fetchMock)
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
                  baseUrl,
                  modelId,
                  apiKey: undefined
                },
                wordMs,
                createClient
              )
          )
          const result = await module.addBatch(
            { requestId: randomUUID(), text: 'apple', wordLanguage: 'en' },
            'en'
          )
          if (responseKind === 'tool') {
            expect(result.counts.saved).toBe(1)
            expect(repository.list({}).entries).toEqual([
              expect.objectContaining({ term: 'apple', exampleSentences: ['I ate an apple.'] })
            ])
          } else {
            expect(result.counts.saved).toBe(0)
            expect(result.counts.failed).toBe(1)
            expect(result.items[0]).toMatchObject({ status: 'failed', code: 'INVALID_ANALYSIS' })
            expect(repository.list({}).entries).toEqual([])
          }
          expect(fetchMock).toHaveBeenCalledTimes(1)
        } finally {
          database.close()
        }
      }
    )
  }
)
