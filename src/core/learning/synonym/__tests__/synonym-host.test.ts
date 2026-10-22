import { randomUUID } from 'node:crypto'
import { expect, it, vi } from 'vitest'
import { SynonymHost } from '../synonym-host'

it('binds model turns to the current word and commits only an authorized tool decision', async () => {
  const saveWord = vi.fn()
  const repo = {
    findExisting: () => new Map(),
    findGroups: () => ({ groups: [], nextCursor: null }),
    listGroups: vi.fn(),
    saveWord,
    saveReport: vi.fn()
  }
  const host = new SynonymHost(
    repo,
    () => ({
      analyze: async () => ({
        canCorrectParallel: false,
        message: {
          tool_calls: [
            {
              id: 'a',
              type: 'function',
              function: {
                name: 'create_synonym_group_and_add_word',
                arguments: JSON.stringify({
                  word: 'adequate',
                  meaning: 'enough',
                  groupMeaning: 'enough',
                  distinction: 'neutral'
                })
              }
            }
          ]
        }
      })
    }),
    {
      requestId: randomUUID(),
      executionId: randomUUID(),
      sessionId: randomUUID(),
      userMessageId: randomUUID(),
      arguments: { text: 'adequate,decent', wordLanguage: 'en' },
      explanationLanguage: 'en',
      signal: new AbortController().signal,
      onPhase: vi.fn()
    }
  )
  expect(host.prepare().items.map((i) => i.status)).toEqual(['pending', 'pending'])
  const signal = new AbortController().signal
  await expect(
    host.model({ inputIndex: 1, round: 1, systemPrompt: 'English' }, signal)
  ).rejects.toMatchObject({ code: 'AGENT_PROTOCOL_ERROR' })
  await host.model({ inputIndex: 0, round: 1, systemPrompt: 'English' }, signal)
  expect(host.apply({ inputIndex: 0, round: 1, action: 'execute' }, signal).kind).toBe('failed')
  expect(saveWord).not.toHaveBeenCalled()
})

it('checks the complete transcript budget before making a model request', async () => {
  const analyze = vi.fn()
  const host = new SynonymHost(
    {
      findExisting: () => new Map(),
      findGroups: vi.fn(),
      listGroups: vi.fn(),
      saveWord: vi.fn(),
      saveReport: vi.fn()
    },
    () => ({ analyze }),
    {
      requestId: randomUUID(),
      executionId: randomUUID(),
      sessionId: randomUUID(),
      userMessageId: randomUUID(),
      arguments: { text: 'adequate', wordLanguage: 'en' },
      explanationLanguage: 'en',
      signal: new AbortController().signal,
      onPhase: vi.fn()
    }
  )
  host.prepare()
  await expect(
    host.model(
      { inputIndex: 0, round: 1, systemPrompt: 'English' },
      new AbortController().signal,
      1
    )
  ).rejects.toMatchObject({ code: 'AGENT_LIMIT' })
  expect(analyze).not.toHaveBeenCalled()
})

it('refuses a previously proposed write after the word deadline', async () => {
  const saveWord = vi.fn()
  const host = new SynonymHost(
    {
      findExisting: () => new Map(),
      findGroups: () => ({ groups: [], nextCursor: null }),
      listGroups: vi.fn(),
      saveWord,
      saveReport: vi.fn()
    },
    () => ({
      analyze: async () => ({
        canCorrectParallel: false,
        message: {
          tool_calls: [
            {
              id: 'query',
              type: 'function',
              function: {
                name: 'find_synonym_groups',
                arguments: '{"word":"adequate","meaning":"enough"}'
              }
            }
          ]
        }
      })
    }),
    {
      requestId: randomUUID(),
      executionId: randomUUID(),
      sessionId: randomUUID(),
      userMessageId: randomUUID(),
      arguments: { text: 'adequate', wordLanguage: 'en' },
      explanationLanguage: 'en',
      signal: new AbortController().signal,
      onPhase: vi.fn()
    }
  )
  const signal = new AbortController().signal
  vi.useFakeTimers({ toFake: ['performance'] })
  try {
    host.prepare()
    await host.model({ inputIndex: 0, round: 1, systemPrompt: 'English' }, signal)
    vi.spyOn(performance, 'now').mockReturnValue(60_001)
    expect(host.apply({ inputIndex: 0, round: 1, action: 'execute' }, signal).kind).toBe('failed')
    expect(host.report(false).items[0]).toMatchObject({ status: 'failed', code: 'TIMEOUT' })
    expect(saveWord).not.toHaveBeenCalled()
  } finally {
    vi.restoreAllMocks()
    vi.useRealTimers()
  }
})
