import { expect, it, vi } from 'vitest'
import type { AgentSnapshot, AgentOperation, VocabularyAnalysisReceipt } from '../../agent-protocol'
import { boundHost, noop, signal } from './task-fixture'

type Task = 'vocabulary' | 'phrase'
function setup(
  task: Task,
  analyze: (
    args: { inputIndex: number; systemPrompt: string },
    signal: AbortSignal
  ) => Promise<VocabularyAnalysisReceipt>,
  adjust?: (snapshot: AgentSnapshot) => void
): ReturnType<typeof boundHost> {
  const items = [0, 1, 2].map((inputIndex) => ({ inputIndex, status: 'pending' as const }))
  return task === 'vocabulary'
    ? boundHost(
        {
          task,
          host: {
            prepare: () => ({ items: items.map((item) => ({ ...item, term: 'word' })) }),
            analyze,
            verifyCompletion: noop
          }
        },
        adjust
      )
    : boundHost(
        {
          task,
          host: {
            prepare: () => ({ items: items.map((item) => ({ ...item, phrase: 'a phrase' })) }),
            analyze,
            verifyCompletion: noop
          }
        },
        adjust
      )
}
const operation = (task: Task): AgentOperation =>
  task === 'vocabulary' ? 'model.vocabulary' : 'model.phrase'

it.each(['vocabulary', 'phrase'] as const)(
  '%s claims each pending index once and forwards the exact Prompt and signal',
  async (task) => {
    const analyze = vi.fn(async ({ inputIndex }: { inputIndex: number; systemPrompt: string }) => ({
      inputIndex,
      status: 'staged' as const
    }))
    const { host } = setup(task, analyze)
    const abort = signal()
    await expect(
      host.call('early', operation(task), { inputIndex: 0, systemPrompt: 'English' }, noop, abort)
    ).rejects.toMatchObject({ code: 'AGENT_PROTOCOL_ERROR' })
    expect(analyze).not.toHaveBeenCalled()
    await host.call('prepare', `${task}.prepare`, {}, noop, abort)
    const args = { inputIndex: 0, systemPrompt: 'Explain in 简体中文, examples in English.' }
    await expect(host.call('first', operation(task), args, noop, abort)).resolves.toEqual({
      inputIndex: 0,
      status: 'staged'
    })
    expect(analyze).toHaveBeenCalledExactlyOnceWith(args, abort)
    await expect(host.call('repeat', operation(task), args, noop, abort)).rejects.toMatchObject({
      code: 'AGENT_PROTOCOL_ERROR'
    })
    await expect(
      host.call('prepare-again', `${task}.prepare`, {}, noop, abort)
    ).rejects.toMatchObject({ code: 'AGENT_PROTOCOL_ERROR' })
    expect(analyze).toHaveBeenCalledOnce()
  }
)

it.each(['vocabulary', 'phrase'] as const)(
  '%s reserves concurrent model budgets before either analysis resolves',
  async (task) => {
    let release!: (receipt: VocabularyAnalysisReceipt) => void
    const analyze = vi.fn(
      () =>
        new Promise<VocabularyAnalysisReceipt>((resolve) => {
          release = resolve
        })
    )
    const { host } = setup(task, analyze, (snapshot) => {
      snapshot.budget.maxModelCalls = 1
    })
    const abort = signal()
    await host.call('prepare', `${task}.prepare`, {}, noop, abort)
    const first = host.call(
      'first',
      operation(task),
      { inputIndex: 0, systemPrompt: 'English' },
      noop,
      abort
    )
    await expect(
      host.call('second', operation(task), { inputIndex: 1, systemPrompt: 'English' }, noop, abort)
    ).rejects.toMatchObject({ code: 'AGENT_LIMIT' })
    // A duplicate index remains a protocol error even after the budget is spent.
    await expect(
      host.call('repeat', operation(task), { inputIndex: 0, systemPrompt: 'English' }, noop, abort)
    ).rejects.toMatchObject({ code: 'AGENT_PROTOCOL_ERROR' })
    expect(analyze).toHaveBeenCalledOnce()
    release({ inputIndex: 0, status: 'staged' })
    await expect(first).resolves.toEqual({ inputIndex: 0, status: 'staged' })
  }
)

it.each(['vocabulary', 'phrase'] as const)(
  '%s rejects receipts for another index',
  async (task) => {
    const analyze = vi.fn(async () => ({ inputIndex: 1, status: 'staged' as const }))
    const { host } = setup(task, analyze)
    const abort = signal()
    await host.call('prepare', `${task}.prepare`, {}, noop, abort)
    await expect(
      host.call('first', operation(task), { inputIndex: 0, systemPrompt: 'English' }, noop, abort)
    ).rejects.toMatchObject({ code: 'AGENT_PROTOCOL_ERROR' })
  }
)

it.each(['vocabulary', 'phrase'] as const)(
  '%s meters analysis receipt JSON without charging the prepared item snapshot',
  async (task) => {
    const receipt = { inputIndex: 0, status: 'staged' as const }
    const analyze = vi.fn(async () => receipt)
    const { host } = setup(task, analyze, (snapshot) => {
      snapshot.budget.maxOutputChars = JSON.stringify(receipt).length
    })
    const abort = signal()
    await host.call('prepare', `${task}.prepare`, {}, noop, abort)
    await expect(
      host.call('first', operation(task), { inputIndex: 0, systemPrompt: 'English' }, noop, abort)
    ).resolves.toEqual(receipt)
  }
)

it.each(['vocabulary', 'phrase'] as const)(
  '%s includes bound items and actual tool definitions in input limits',
  async (task) => {
    const analyze = vi.fn()
    const { host } = setup(task, analyze, (snapshot) => {
      snapshot.budget.maxInputChars = 4096
    })
    const abort = signal()
    await host.call('prepare', `${task}.prepare`, {}, noop, abort)
    await expect(
      host.call(
        'first',
        operation(task),
        { inputIndex: 0, systemPrompt: 'x'.repeat(4096) },
        noop,
        abort
      )
    ).rejects.toMatchObject({ code: 'AGENT_LIMIT' })
    expect(analyze).not.toHaveBeenCalled()
  }
)
