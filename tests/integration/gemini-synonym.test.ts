import { randomUUID } from 'node:crypto'
import { SynonymHost } from '../../src/core/learning/synonym/synonym-host'
import { LlmSynonymAnalyzer } from '../../src/core/llm/llm-synonym-analyzer'
import { createTestBatchRuntime } from '../fixtures/python-agent'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LlmClient } from '../../src/core/llm/llm-client'
import { LlmUsageRecorder } from '../../src/core/llm/llm-usage-recorder'
import type { LlmUsageTerminal } from '../../src/core/llm/llm-usage'

const params = {
  model: 'gemini-test',
  messages: [{ role: 'user' as const, content: 'Reply in English: hello' }]
}
const reply = (
  parts: unknown[] = [{ text: 'hello' }],
  finishReason = 'STOP'
): Record<string, unknown> => ({
  candidates: [{ content: { parts }, finishReason }],
  modelVersion: 'gemini-test',
  usageMetadata: {
    promptTokenCount: 5,
    candidatesTokenCount: 32,
    thoughtsTokenCount: 135,
    totalTokenCount: 172
  }
})
function client(): { client: LlmClient; finished: LlmUsageTerminal[] } {
  const finished: LlmUsageTerminal[] = []
  return {
    finished,
    client: new LlmClient(
      { protocol: 'gemini', baseUrl: 'https://example.com/gemini/v1beta/', apiKey: 'test-key' },
      new LlmUsageRecorder({
        insertStarted: () => {},
        finish: (record) => {
          finished.push(record)
        },
        markInterruptedStarted: () => 0,
        list: () => []
      })
    )
  }
}
afterEach(() => vi.unstubAllGlobals())

describe('Gemini synonym single-call recovery', () => {
  it.each(['recover', 'repeat', 'out-of-order'] as const)(
    'rejects the entire parallel turn before handling %s',
    async (scenario) => {
      const query = { word: 'adequate', meaning: 'enough' }
      const create = { ...query, groupMeaning: 'enough', distinction: 'neutral' }
      const parallel = [
        {
          functionCall: { name: 'find_synonym_groups', args: query, id: 'query' },
          thoughtSignature: 'signed'
        },
        { functionCall: { name: 'create_synonym_group_and_add_word', args: create, id: 'write' } }
      ]
      const responses = [
        reply(parallel),
        scenario === 'repeat'
          ? reply(parallel)
          : reply([
              {
                functionCall: {
                  name:
                    scenario === 'out-of-order'
                      ? 'create_synonym_group_and_add_word'
                      : 'find_synonym_groups',
                  args: scenario === 'out-of-order' ? create : query
                }
              }
            ]),
        reply([{ functionCall: { name: 'create_synonym_group_and_add_word', args: create } }])
      ]
      const save = vi.fn(() => ({
        status: 'saved' as const,
        entry: { id: randomUUID(), groupid: randomUUID(), ...query, distinction: 'neutral' }
      }))
      const findGroups = vi.fn(() => ({ groups: [], nextCursor: null }))
      const fetchMock = vi.fn(async () => {
        expect(save).not.toHaveBeenCalled()
        return Response.json(responses.shift())
      })
      vi.stubGlobal('fetch', fetchMock)
      const subject = client()
      const signal = new AbortController().signal
      const analyzer = new LlmSynonymAnalyzer(
        {
          configured: true,
          protocol: 'gemini',
          baseUrl: 'https://example.com/v1beta',
          modelId: params.model,
          apiKey: undefined
        },
        1000,
        () => subject.client
      )
      const host = new SynonymHost(
        {
          findGroups,
          findExisting: () => new Map(),
          listGroups: vi.fn(),
          saveWord: (_id, _content, finalize) => {
            const result = save()
            finalize(result)
            return result
          },
          saveReport: vi.fn()
        },
        () => analyzer,
        {
          requestId: randomUUID(),
          executionId: randomUUID(),
          sessionId: randomUUID(),
          userMessageId: randomUUID(),
          arguments: { text: 'adequate', wordLanguage: 'en' },
          explanationLanguage: 'en',
          signal,
          onPhase: vi.fn()
        }
      )
      const pending = createTestBatchRuntime().runSynonym(
        { outputLanguage: 'en', targetLanguage: 'en', signal },
        host
      )
      if (scenario === 'recover') {
        await pending
        expect(save).toHaveBeenCalledOnce()
        expect(findGroups).toHaveBeenCalledOnce()
        expect(subject.finished).toHaveLength(3)
      } else {
        await pending
        expect(host.report(true).items[0]).toMatchObject({
          status: 'failed',
          code: 'INVALID_ANALYSIS'
        })
        expect(save).not.toHaveBeenCalled()
        expect(findGroups).not.toHaveBeenCalled()
        expect(fetchMock).toHaveBeenCalledTimes(2)
      }
      const init = (fetchMock.mock.calls[1] as unknown as [string, RequestInit])[1]
      const body = JSON.parse(String(init.body))
      expect(body.contents[1]).toEqual({ role: 'model', parts: parallel })
      expect(body.contents[2].parts).toEqual([
        {
          functionResponse: {
            name: 'find_synonym_groups',
            id: 'query',
            response: { error: 'SINGLE_TOOL_CALL_REQUIRED' }
          }
        },
        {
          functionResponse: {
            name: 'create_synonym_group_and_add_word',
            id: 'write',
            response: { error: 'SINGLE_TOOL_CALL_REQUIRED' }
          }
        }
      ])
    }
  )
})
