import { describe, expect, it, vi } from 'vitest'
import { AgentHost } from '../agent-host'
import { createAgentSnapshot } from '../agent-runtime'

const input = (): import('../agent-runtime').AgentTask => ({
  task: 'conversation' as const,
  messages: [{ role: 'user' as const, content: 'Hello' }],
  outputLanguage: 'zh-CN',
  targetLanguage: 'en'
})

describe('AgentHost', () => {
  it('passes Python instructions unchanged to the model bound to this run', async () => {
    const seen: unknown[] = []
    const snapshot = createAgentSnapshot(input())
    const host = new AgentHost(snapshot, () => ({
      async *streamReply(input) {
        seen.push(input)
        yield { type: 'text', delta: 'answer' }
      }
    }))
    await host.call(
      'reply',
      'model.reply',
      { systemPrompt: 'Explain in English.' },
      () => {},
      new AbortController().signal
    )
    expect(seen).toEqual([
      expect.objectContaining({
        systemPrompt: 'Explain in English.',
        messages: snapshot.messages,
        purpose: 'conversation'
      })
    ])
  })
  it.each([
    ['missing', {}],
    ['empty', { systemPrompt: '' }],
    ['oversized', { systemPrompt: 'x'.repeat(4097) }],
    ['extra fields', { systemPrompt: 'English', query: 'override' }]
  ] as const)('rejects %s reply instructions before resolving a model', async (_name, args) => {
    const resolve = vi.fn()
    const host = new AgentHost(createAgentSnapshot(input()), resolve)
    await expect(
      host.call('invalid', 'model.reply', args, () => {}, new AbortController().signal)
    ).rejects.toMatchObject({ code: 'AGENT_PROTOCOL_ERROR' })
    expect(resolve).not.toHaveBeenCalled()
  })
  it('counts the actual Prompt and bound history against the input budget', async () => {
    const snapshot = createAgentSnapshot(input())
    snapshot.messages = [{ role: 'user', content: '😀'.repeat(2040) }]
    snapshot.budget.maxInputChars = 4096
    const resolve = vi.fn()
    const host = new AgentHost(snapshot, resolve)
    await expect(
      host.call(
        'overflow',
        'model.reply',
        { systemPrompt: 'English instructions' },
        () => {},
        new AbortController().signal
      )
    ).rejects.toMatchObject({ code: 'AGENT_LIMIT' })
    expect(resolve).not.toHaveBeenCalled()
  })
  it('denies operations outside the trusted run permissions before touching a model or tool', async () => {
    const model = vi.fn()
    const host = new AgentHost(createAgentSnapshot(input()), model)
    await expect(
      host.call(
        'call-1',
        'learning.lookup',
        { query: 'word' },
        () => {},
        new AbortController().signal
      )
    ).rejects.toMatchObject({ code: 'AGENT_PROTOCOL_ERROR' })
    expect(model).not.toHaveBeenCalled()
  })
  it('streams once through the host with stable language and model snapshots and enforces call budgets', async () => {
    const seen: unknown[] = []
    const resolve = vi.fn(
      () =>
        ({
          async *streamReply(input) {
            seen.push(input)
            yield { type: 'reasoning' as const, delta: 'think' }
            yield { type: 'text' as const, delta: 'reply' }
          }
        }) satisfies import('../../llm/language-model').LanguageModel
    )
    const snapshot = createAgentSnapshot(input())
    snapshot.budget.maxModelCalls = 2
    const host = new AgentHost(snapshot, resolve)
    const chunks: unknown[] = []
    const signal = new AbortController().signal
    expect(
      await host.call(
        'a',
        'model.reply',
        { systemPrompt: 'Explain in English.' },
        (e) => {
          chunks.push(e)
        },
        signal
      )
    ).toEqual({ text: 'reply' })
    await host.call('b', 'model.reply', { systemPrompt: 'Explain in English.' }, () => {}, signal)
    expect(resolve).toHaveBeenCalledTimes(1)
    expect(chunks).toEqual([
      { type: 'reasoning', delta: 'think' },
      { type: 'text', delta: 'reply' }
    ])
    expect(seen[0]).toMatchObject({
      systemPrompt: 'Explain in English.',
      purpose: 'conversation'
    })
    await expect(
      host.call('c', 'model.reply', { systemPrompt: 'Explain in English.' }, () => {}, signal)
    ).rejects.toMatchObject({
      code: 'AGENT_LIMIT'
    })
    await expect(
      host.call('a', 'model.reply', { systemPrompt: 'Explain in English.' }, () => {}, signal)
    ).rejects.toMatchObject({
      code: 'AGENT_PROTOCOL_ERROR'
    })
  })
  it('runs bounded read-only decisions with language snapshots and validates the tool result', async () => {
    const decision = vi.fn(
      async (input: Parameters<import('../agent-host').AgentTestOperations['decide']>[0]) => {
        void input
        return {
          kind: 'tool' as const,
          name: 'learning.lookup' as const,
          query: 'carry'
        }
      }
    )
    const lookup = vi.fn(async () => ({ entries: ['carry: transport'] }))
    const host = new AgentHost(createAgentSnapshot({ ...input(), task: 'tool-loop' }), vi.fn(), {
      decide: decision,
      lookup
    })
    const signal = new AbortController().signal
    expect(await host.call('1', 'model.decide', { results: [] }, () => {}, signal)).toMatchObject({
      kind: 'tool',
      query: 'carry'
    })
    expect(await host.call('2', 'learning.lookup', { query: 'carry' }, () => {}, signal)).toEqual({
      entries: ['carry: transport']
    })
    expect(decision.mock.calls[0][0]).toMatchObject({
      outputLanguage: 'zh-CN',
      targetLanguage: 'en',
      results: []
    })
    expect(lookup).toHaveBeenCalledWith('carry', signal)
  })
  it('enforces the host output limit before accepting a final model decision', async () => {
    const snapshot = createAgentSnapshot({ ...input(), task: 'tool-loop' })
    snapshot.budget.maxOutputChars = 4
    const host = new AgentHost(snapshot, vi.fn(), {
      async decide() {
        return { kind: 'final', text: 'too long' }
      },
      async lookup() {
        return { entries: [] }
      }
    })
    await expect(
      host.call('final', 'model.decide', { results: [] }, () => {}, new AbortController().signal)
    ).rejects.toMatchObject({ code: 'AGENT_LIMIT' })
  })
})
