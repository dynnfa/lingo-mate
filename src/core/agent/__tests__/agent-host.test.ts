import { describe, expect, it, vi } from 'vitest'
import { AgentHost } from '../agent-host'
import { createAgentSnapshot, type VocabularyHostOperations } from '../agent-runtime'
import type { AgentSnapshot } from '../agent-protocol'
import type { LanguageModel } from '../../llm/language-model'
import type { AgentTestOperations } from '../agent-task'
import { createAgentTaskBinding } from '../agent-task-binding'

function createHost(
  snapshot: AgentSnapshot,
  resolveModel: () => LanguageModel,
  operations?: AgentTestOperations,
  vocabulary?: VocabularyHostOperations
): AgentHost {
  if (snapshot.task === 'vocabulary' && vocabulary)
    return new AgentHost(
      snapshot,
      createAgentTaskBinding(snapshot, { task: 'vocabulary', host: vocabulary })
    )
  if (snapshot.task === 'tool-loop' && operations)
    return new AgentHost(
      snapshot,
      createAgentTaskBinding(snapshot, { task: 'tool-loop', operations })
    )
  if (snapshot.task === 'conversation' || snapshot.task === 'conversation-title')
    return new AgentHost(
      snapshot,
      createAgentTaskBinding(snapshot, { task: snapshot.task, resolveModel })
    )
  throw new Error('Missing test binding')
}

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
    const host = createHost(snapshot, () => ({
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
    const host = createHost(createAgentSnapshot(input()), resolve)
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
    const host = createHost(snapshot, resolve)
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
    const host = createHost(createAgentSnapshot(input()), model)
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
    const host = createHost(snapshot, resolve)
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
    const host = createHost(createAgentSnapshot({ ...input(), task: 'tool-loop' }), vi.fn(), {
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
    const host = createHost(snapshot, vi.fn(), {
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

it('budgets vocabulary from the bound term and tool definitions rather than a fixed guess', async () => {
  const snapshot = createAgentSnapshot({ ...input(), task: 'vocabulary' })
  snapshot.budget.maxInputChars = 4096
  const analyze = vi.fn(async () => ({ inputIndex: 0, status: 'staged' as const }))
  const host = createHost(snapshot, vi.fn(), undefined, {
    prepare: () => ({ items: [{ inputIndex: 0, term: 'apple', status: 'pending' }] }),
    analyze,
    verifyCompletion: () => {}
  })
  const signal = new AbortController().signal
  await host.call('prepare', 'vocabulary.prepare', {}, () => {}, signal)
  await expect(
    host.call(
      'analyze',
      'model.vocabulary',
      { inputIndex: 0, systemPrompt: 'Explain in English.' },
      () => {},
      signal
    )
  ).resolves.toEqual({ inputIndex: 0, status: 'staged' })
  expect(analyze).toHaveBeenCalledTimes(1)
})

it('generates a title through its own permission and ignores all reasoning', async () => {
  const seen: unknown[] = []
  const chunks: unknown[] = []
  const snapshot = createAgentSnapshot({ ...input(), task: 'conversation-title' })
  const host = createHost(snapshot, () => ({
    async *streamReply(input) {
      seen.push(input)
      yield { type: 'reasoning', delta: 'thought'.repeat(1000) }
      yield { type: 'text', delta: 'Coffee practice' }
    }
  }))
  expect(snapshot.budget).toEqual({
    timeoutMs: 120_000,
    maxModelCalls: 1,
    maxToolCalls: 0,
    maxSteps: 1,
    maxInputChars: 32_768,
    maxOutputChars: 80
  })
  const signal = new AbortController().signal
  expect(
    await host.call(
      'title',
      'model.title',
      { systemPrompt: 'Title in English.' },
      (e) => {
        chunks.push(e)
      },
      signal
    )
  ).toEqual({ text: 'Coffee practice' })
  expect(chunks).toEqual([{ type: 'text', delta: 'Coffee practice' }])
  expect(seen).toEqual([
    expect.objectContaining({
      purpose: 'conversation-title',
      systemPrompt: 'Title in English.',
      messages: snapshot.messages
    })
  ])
  await expect(
    host.call('reply', 'model.reply', { systemPrompt: 'English' }, () => {}, signal)
  ).rejects.toMatchObject({ code: 'AGENT_PROTOCOL_ERROR' })
  const conversation = createHost(createAgentSnapshot(input()), vi.fn())
  await expect(
    conversation.call('title', 'model.title', { systemPrompt: 'English' }, () => {}, signal)
  ).rejects.toMatchObject({ code: 'AGENT_PROTOCOL_ERROR' })
})

it('does not resolve a model or emit output for a pre-cancelled call', async () => {
  const resolve = vi.fn()
  const emit = vi.fn()
  const host = createHost(createAgentSnapshot(input()), resolve)
  const controller = new AbortController()
  controller.abort()
  await expect(
    host.call('reply', 'model.reply', { systemPrompt: 'English' }, emit, controller.signal)
  ).rejects.toMatchObject({ name: 'AbortError' })
  expect(resolve).not.toHaveBeenCalled()
  expect(emit).not.toHaveBeenCalled()
})

it('meters stream deltas once without charging the final text again', async () => {
  const snapshot = createAgentSnapshot(input())
  snapshot.budget.maxOutputChars = 6
  const host = createHost(snapshot, () => ({
    async *streamReply() {
      yield { type: 'reasoning', delta: 'ab' }
      yield { type: 'text', delta: 'cd' }
      yield { type: 'text', delta: 'ef' }
    }
  }))
  await expect(
    host.call(
      'reply',
      'model.reply',
      { systemPrompt: 'English' },
      () => {},
      new AbortController().signal
    )
  ).resolves.toEqual({ text: 'cdef' })
})

it('does not emit a late model event after cancellation', async () => {
  const abort = new AbortController()
  const emit = vi.fn()
  const host = createHost(createAgentSnapshot(input()), () => ({
    async *streamReply() {
      abort.abort()
      yield { type: 'text', delta: 'late' }
    }
  }))
  await expect(
    host.call('reply', 'model.reply', { systemPrompt: 'English' }, emit, abort.signal)
  ).rejects.toMatchObject({ name: 'AbortError' })
  expect(emit).not.toHaveBeenCalled()
})
