import { randomUUID } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { LlmSynonymAnalyzer } from '../llm-synonym-analyzer'
import type { CreateLlmClient } from '../llm-client'
import { SynonymToolExecutor } from '../../tools/synonym-tools'
import type { SynonymRepository } from '../../learning/synonym/synonym-repository'
import type { RuntimeModelConfig } from '../model-config'

const config: RuntimeModelConfig = {
  configured: true,
  protocol: 'openai-compatible',
  baseUrl: 'http://localhost:1234/v1',
  modelId: 'test',
  apiKey: undefined
}
function response(name: string, args: unknown, id = randomUUID()): Record<string, unknown> {
  return {
    choices: [
      {
        finish_reason: 'tool_calls',
        message: {
          content: null,
          tool_calls: [
            { id, type: 'function', function: { name, arguments: JSON.stringify(args) } }
          ]
        }
      }
    ]
  }
}
function setup(
  responses: unknown[],
  maxRounds = 52
): {
  complete: ReturnType<typeof vi.fn>
  save: ReturnType<typeof vi.fn>
  run: () => Promise<void>
} {
  const complete = vi.fn().mockImplementation(async () => responses.shift())
  const client = { complete, stream: vi.fn() } satisfies ReturnType<CreateLlmClient>
  const save = vi.fn(() => ({
    status: 'saved' as const,
    entry: {
      id: randomUUID(),
      word: 'adequate',
      meaning: 'okay',
      distinction: 'neutral',
      groupid: randomUUID()
    }
  }))
  const repository: SynonymRepository = {
    findExisting: vi.fn(),
    findGroups: () => ({ groups: [], nextCursor: null }),
    listGroups: vi.fn(),
    saveWord: vi.fn(),
    saveReport: vi.fn()
  }
  const signal = new AbortController().signal
  const executor = new SynonymToolExecutor('adequate', repository, save, signal)
  const analyzer = new LlmSynonymAnalyzer(config, 1000, () => client, maxRounds)
  return {
    complete,
    save,
    run: () =>
      analyzer.analyze({ word: 'adequate', explanationLanguage: 'zh-CN', signal, executor })
  }
}
const query = { word: 'adequate', meaning: '尚可' }
const create = { ...query, groupMeaning: '尚可', distinction: '达到最低要求' }
describe('synonym multi-turn adapter', () => {
  it('returns correlated assistant calls and tool results, with explicit output language and per-round usage', async () => {
    const id = randomUUID()
    const { run, complete, save } = setup([
      response('find_synonym_groups', query, id),
      response('create_synonym_group_and_add_word', create)
    ])
    await run()
    expect(save).toHaveBeenCalledOnce()
    expect(complete).toHaveBeenCalledTimes(2)
    const messages = complete.mock.calls[1][0].messages
    expect(messages[0].content).toContain('Simplified Chinese')
    expect(messages[2].tool_calls[0].id).toBe(id)
    expect(messages[3]).toMatchObject({
      role: 'tool',
      tool_call_id: id,
      content: JSON.stringify({ groups: [], nextCursor: null })
    })
    for (const call of complete.mock.calls) expect(call[1].operation).toBe('synonym_analysis')
  })
  it.each([
    response('create_synonym_group_and_add_word', create),
    response('unknown', query),
    {
      choices: [
        {
          finish_reason: 'tool_calls',
          message: {
            content: null,
            tool_calls: [
              {
                id: 'query',
                type: 'function',
                function: { name: 'find_synonym_groups', arguments: JSON.stringify(query) }
              },
              {
                id: 'write',
                type: 'function',
                function: {
                  name: 'create_synonym_group_and_add_word',
                  arguments: JSON.stringify(create)
                }
              }
            ]
          }
        }
      ]
    },
    response('find_synonym_groups', { ...query, word: 'other' }),
    { choices: [{ finish_reason: 'stop', message: { content: 'Saved successfully' } }] },
    {
      choices: [
        {
          finish_reason: 'tool_calls',
          message: {
            content: null,
            tool_calls: [
              {
                id: 'x',
                type: 'function',
                function: { name: 'find_synonym_groups', arguments: '{' }
              }
            ]
          }
        }
      ]
    }
  ])('rejects malformed or out-of-order tool responses', async (completion) => {
    const { run, save } = setup([completion])
    await expect(run()).rejects.toMatchObject({ code: 'INVALID_ANALYSIS' })
    expect(save).not.toHaveBeenCalled()
  })
  it('stops at the round limit without writing', async () => {
    const { run, save } = setup([response('find_synonym_groups', query)], 1)
    await expect(run()).rejects.toMatchObject({ code: 'ROUND_LIMIT' })
    expect(save).not.toHaveBeenCalled()
  })
  it('reports unsupported tools and does not fall back to text', async () => {
    const { run, complete, save } = setup([])
    complete.mockRejectedValue({ status: 400, message: 'tools are not supported' })
    await expect(run()).rejects.toMatchObject({ code: 'TOOL_CALL_NOT_SUPPORTED' })
    expect(save).not.toHaveBeenCalled()
  })
  it('accepts unrecognized words without any storage tool', async () => {
    const { run, save } = setup([response('report_unrecognized_word', { word: 'adequate' })])
    await run()
    expect(save).not.toHaveBeenCalled()
  })
})
