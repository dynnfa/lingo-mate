import { randomUUID } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { LlmVocabularyPracticeReviewer } from '../llm-vocabulary-practice-reviewer'
import type { CreateLlmClient } from '../llm-client'
import type { RuntimeModelConfig } from '../model-config'

const config: RuntimeModelConfig = {
  configured: true,
  protocol: 'openai-compatible',
  baseUrl: 'http://localhost:1234/v1',
  modelId: 'test',
  apiKey: undefined
}

const UUID = '11111111-1111-4111-8111-111111111111'
const UUID2 = '22222222-2222-4222-8222-222222222222'

const ENTRIES = [
  { entryId: UUID, term: 'apple', submittedMeaning: '苹果', referenceMeaning: '一种水果' },
  { entryId: UUID2, term: 'banana', submittedMeaning: 'wrong', referenceMeaning: null }
]

function toolCallResponse(calls: Array<{ name: string; args: unknown; id?: string }>): unknown {
  return {
    choices: [
      {
        finish_reason: 'tool_calls',
        message: {
          content: null,
          tool_calls: calls.map((call) => ({
            id: call.id ?? randomUUID(),
            type: 'function',
            function: { name: call.name, arguments: JSON.stringify(call.args) }
          }))
        }
      }
    ]
  }
}

function finalResponse(content: string): unknown {
  return {
    choices: [{ finish_reason: 'stop', message: { role: 'assistant', content } }]
  }
}

function setup(
  responses: unknown[],
  maxRounds = 8
): {
  complete: ReturnType<typeof vi.fn>
  run: () => Promise<unknown>
  signal: AbortSignal
} {
  const complete = vi.fn().mockImplementation(async () => responses.shift())
  const client = { complete, stream: vi.fn() } satisfies ReturnType<CreateLlmClient>
  const reviewer = new LlmVocabularyPracticeReviewer(config, 1000, () => client, maxRounds)
  const signal = new AbortController().signal
  return {
    complete,
    signal,
    run: () => reviewer.review({ entries: ENTRIES, explanationLanguage: 'zh-CN', signal })
  }
}

const HAS_ERRORS = JSON.stringify({ verdict: 'has_errors', summary: 'banana 的释义有误。' })
const ALL_CORRECT = JSON.stringify({ verdict: 'all_correct', summary: '全部正确。' })

describe('llm vocabulary practice reviewer', () => {
  it('executes mark calls, returns correlated tool results and finishes with feedback', async () => {
    const id = randomUUID()
    const { run, complete } = setup([
      toolCallResponse([
        {
          name: 'mark_text_red',
          args: { items: [{ entryId: UUID2, field: 'meaning', reason: '释义与单词无关' }] },
          id
        }
      ]),
      finalResponse(HAS_ERRORS)
    ])
    const outcome = await run()
    expect(outcome).toEqual({
      verdict: 'has_errors',
      summary: 'banana 的释义有误。',
      marks: [{ entryId: UUID2, field: 'meaning', reason: '释义与单词无关' }]
    })
    // 第二轮请求包含 assistant 工具调用消息与按 id 回传的结果
    const messages = complete.mock.calls[1][0].messages as Array<Record<string, unknown>>
    expect(messages[2]).toMatchObject({ role: 'assistant' })
    expect((messages[2].tool_calls as Array<{ id: string }>)[0].id).toBe(id)
    expect(messages[3]).toEqual({
      role: 'tool',
      tool_call_id: id,
      content: JSON.stringify({ status: 'marked', markedCount: 1 })
    })
    // 系统消息包含输出语言指令，请求以 auto 工具选择注册
    expect(messages[0].content as string).toContain('Simplified Chinese')
    expect(complete.mock.calls[0][0].tool_choice).toBe('auto')
  })

  it('marks several items across multiple calls in one turn', async () => {
    const { run } = setup([
      toolCallResponse([
        {
          name: 'mark_text_red',
          args: { items: [{ entryId: UUID, field: 'meaning', reason: 'a' }] }
        },
        {
          name: 'mark_text_red',
          args: { items: [{ entryId: UUID2, field: 'meaning', reason: 'b' }] }
        }
      ]),
      finalResponse(HAS_ERRORS)
    ])
    const outcome = (await run()) as { marks: unknown[] }
    expect(outcome.marks).toHaveLength(2)
  })

  it('finishes with zero tool calls when everything is correct', async () => {
    const { run, complete } = setup([finalResponse(ALL_CORRECT)])
    const outcome = await run()
    expect(outcome).toEqual({ verdict: 'all_correct', summary: '全部正确。', marks: [] })
    expect(complete).toHaveBeenCalledTimes(1)
  })

  it('asks the model to complete missing marks before accepting has_errors feedback', async () => {
    const { run, complete } = setup([
      finalResponse(HAS_ERRORS),
      toolCallResponse([
        {
          name: 'mark_text_red',
          args: { items: [{ entryId: UUID2, field: 'meaning', reason: '补齐标记' }] }
        }
      ]),
      finalResponse(HAS_ERRORS)
    ])
    const outcome = (await run()) as { verdict: string; marks: unknown[] }
    expect(outcome.verdict).toBe('has_errors')
    expect(outcome.marks).toHaveLength(1)
    // 补齐指令作为 user 消息进入下一轮
    const messages = complete.mock.calls[1][0].messages as Array<Record<string, unknown>>
    expect(messages[2]).toMatchObject({ role: 'user' })
    expect(String(messages[2].content)).toContain('mark_text_red')
  })

  it('rejects all_correct feedback that contradicts existing marks', async () => {
    const { run } = setup([
      toolCallResponse([
        {
          name: 'mark_text_red',
          args: { items: [{ entryId: UUID2, field: 'meaning', reason: 'x' }] }
        }
      ]),
      finalResponse(ALL_CORRECT)
    ])
    await expect(run()).rejects.toMatchObject({ code: 'INVALID_ANALYSIS' })
  })

  it('fails after bounded correction rounds without marks', async () => {
    const { run, complete } = setup(
      [finalResponse(HAS_ERRORS), finalResponse(HAS_ERRORS), finalResponse(HAS_ERRORS)],
      8
    )
    await expect(run()).rejects.toMatchObject({ code: 'INVALID_ANALYSIS' })
    expect(complete).toHaveBeenCalledTimes(3)
  })

  it.each([
    ['empty content', finalResponse('')],
    ['null content', { choices: [{ finish_reason: 'stop', message: { content: null } }] }],
    [
      'refusal',
      { choices: [{ finish_reason: 'stop', message: { content: null, refusal: 'no' } }] }
    ],
    ['invalid JSON', finalResponse('好的，全部正确！')],
    ['truncated JSON', finalResponse('{"verdict":"all_correct","summary":"…')],
    ['unknown verdict enum', finalResponse('{"verdict":"perfect","summary":"x"}')],
    ['missing summary', finalResponse('{"verdict":"all_correct"}')],
    ['missing choices', { choices: [] }],
    ['unknown tool name', toolCallResponse([{ name: 'delete_everything', args: {} }])]
  ])('rejects protocol violations: %s', async (_label, response) => {
    const { run } = setup([response])
    await expect(run()).rejects.toMatchObject({ code: 'INVALID_ANALYSIS' })
  })

  it.each(['length', 'content_filter', null, 'unknown', 'tool_calls'])(
    'rejects complete final JSON with abnormal finish reason %s',
    async (finishReason) => {
      const { run } = setup([
        { choices: [{ finish_reason: finishReason, message: { content: ALL_CORRECT } }] }
      ])
      await expect(run()).rejects.toMatchObject({ code: 'INVALID_ANALYSIS' })
    }
  )

  it.each(['length', 'content_filter', null, 'stop'])(
    'rejects tool calls with abnormal finish reason %s before continuing',
    async (finishReason) => {
      const { run, complete } = setup([
        {
          choices: [
            {
              finish_reason: finishReason,
              message: {
                content: null,
                tool_calls: [
                  {
                    id: 'call-1',
                    type: 'function',
                    function: {
                      name: 'mark_text_red',
                      arguments: JSON.stringify({
                        items: [{ entryId: UUID2, field: 'meaning', reason: '错误' }]
                      })
                    }
                  }
                ]
              }
            }
          ]
        },
        finalResponse(HAS_ERRORS)
      ])
      await expect(run()).rejects.toMatchObject({ code: 'INVALID_ANALYSIS' })
      expect(complete).toHaveBeenCalledTimes(1)
    }
  )

  it('preserves text accompanying valid tool calls and waits for final feedback', async () => {
    const { run, complete } = setup([
      {
        choices: [
          {
            finish_reason: 'tool_calls',
            message: {
              content: '发现一处错误。',
              tool_calls: [
                {
                  id: 'call-1',
                  type: 'function',
                  function: {
                    name: 'mark_text_red',
                    arguments: JSON.stringify({
                      items: [{ entryId: UUID2, field: 'meaning', reason: '错误' }]
                    })
                  }
                }
              ]
            }
          }
        ]
      },
      finalResponse(HAS_ERRORS)
    ])
    await expect(run()).resolves.toMatchObject({
      verdict: 'has_errors',
      summary: 'banana 的释义有误。',
      marks: [{ entryId: UUID2, field: 'meaning', reason: '错误' }]
    })
    expect(complete).toHaveBeenCalledTimes(2)
    expect(complete.mock.calls[1][0].messages[2]).toMatchObject({
      role: 'assistant',
      content: '发现一处错误。'
    })
    expect(complete.mock.calls[1][0].messages[3]).toMatchObject({
      role: 'tool',
      tool_call_id: 'call-1'
    })
  })

  it('returns safe errors to the model for malformed tool calls and can still finish', async () => {
    const { run, complete } = setup([
      toolCallResponse([{ name: 'mark_text_red', args: '{' }]),
      toolCallResponse([
        {
          name: 'mark_text_red',
          args: { items: [{ entryId: UUID2, field: 'meaning', reason: '修正后的原因' }] }
        }
      ]),
      finalResponse(HAS_ERRORS)
    ])
    const outcome = (await run()) as { marks: Array<{ reason: string }> }
    expect(outcome.marks[0].reason).toBe('修正后的原因')
    const firstToolResult = JSON.parse(
      (complete.mock.calls[1][0].messages as Array<{ content?: string }>)[3].content ?? ''
    ) as { error: string }
    expect(firstToolResult.error).toBe('INVALID_ARGUMENTS')
  })

  it('does not execute forged entry ids and lets the model correct itself', async () => {
    const { run, complete } = setup([
      toolCallResponse([
        {
          name: 'mark_text_red',
          args: { items: [{ entryId: randomUUID(), field: 'meaning', reason: '越界' }] }
        }
      ]),
      toolCallResponse([
        {
          name: 'mark_text_red',
          args: { items: [{ entryId: UUID2, field: 'meaning', reason: '本词条错误' }] }
        }
      ]),
      finalResponse(HAS_ERRORS)
    ])
    const outcome = (await run()) as { marks: Array<{ entryId: string; reason: string }> }
    expect(outcome.marks).toEqual([{ entryId: UUID2, field: 'meaning', reason: '本词条错误' }])
    const firstToolResult = JSON.parse(
      (complete.mock.calls[1][0].messages as Array<{ content?: string }>)[3].content ?? ''
    ) as { error: string }
    expect(firstToolResult.error).toBe('UNKNOWN_ENTRY_ID')
  })

  it('rejects duplicated tool call ids across turns', async () => {
    const id = randomUUID()
    const { run } = setup([
      toolCallResponse([
        {
          name: 'mark_text_red',
          args: { items: [{ entryId: UUID2, field: 'meaning', reason: 'x' }] },
          id
        }
      ]),
      toolCallResponse([
        {
          name: 'mark_text_red',
          args: { items: [{ entryId: UUID, field: 'meaning', reason: 'y' }] },
          id
        }
      ])
    ])
    await expect(run()).rejects.toMatchObject({ code: 'INVALID_ANALYSIS' })
  })

  it('fails at the round limit instead of looping forever', async () => {
    const { run, complete } = setup(
      Array.from({ length: 5 }, () =>
        toolCallResponse([
          {
            name: 'mark_text_red',
            args: { items: [{ entryId: UUID2, field: 'meaning', reason: 'x' }] }
          }
        ])
      ),
      3
    )
    await expect(run()).rejects.toMatchObject({ code: 'ROUND_LIMIT' })
    expect(complete).toHaveBeenCalledTimes(3)
  })

  it('reports unsupported tool capability without falling back to text', async () => {
    const { run, complete } = setup([])
    complete.mockRejectedValue({ status: 400, message: 'tools are not supported' })
    await expect(run()).rejects.toMatchObject({ code: 'TOOL_CALL_NOT_SUPPORTED' })
  })

  it('classifies network failures as model errors', async () => {
    const failure = setup([])
    failure.complete.mockRejectedValue(new Error('socket hang up'))
    await expect(failure.run()).rejects.toMatchObject({ code: 'MODEL_ERROR' })
  })

  it('rejects before any request when no model is configured', async () => {
    const complete = vi.fn()
    const client = { complete, stream: vi.fn() } satisfies ReturnType<CreateLlmClient>
    const reviewer = new LlmVocabularyPracticeReviewer({ configured: false }, 1000, () => client)
    await expect(
      reviewer.review({
        entries: ENTRIES,
        explanationLanguage: 'zh-CN',
        signal: new AbortController().signal
      })
    ).rejects.toMatchObject({ code: 'MODEL_NOT_CONFIGURED' })
    expect(complete).not.toHaveBeenCalled()
  })
})
