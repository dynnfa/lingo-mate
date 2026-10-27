import { expect, it, vi } from 'vitest'
import { boundHost, noop, signal } from './task-fixture'

it.each(['explore-phrase', 'explore-vocabulary'] as const)(
  '%s forwards only the validated attempt, Prompt, signal and actual input limit',
  async (task) => {
    const prepare = vi.fn(() => ({ acceptedCount: 0 as const, inputChars: 123 }))
    const model = vi.fn(async () => ({ attempt: 1, acceptedCount: 10, inputChars: 456 }))
    const verifyCompletion = vi.fn()
    const { host, binding } = boundHost({ task, host: { prepare, model, verifyCompletion } })
    const abort = signal()
    await expect(host.call('prepare', `${task}.prepare`, {}, noop, abort)).resolves.toEqual({
      acceptedCount: 0,
      inputChars: 123
    })
    const args = { attempt: 1, systemPrompt: 'Explain in Chinese; examples in English.' }
    await expect(
      host.call(
        'model',
        task === 'explore-phrase' ? 'model.explore-phrase' : 'model.explore-vocabulary',
        args,
        noop,
        abort
      )
    ).resolves.toEqual({ attempt: 1, acceptedCount: 10, inputChars: 456 })
    expect(model).toHaveBeenCalledExactlyOnceWith(args, abort, 65536)
    binding.adapter.verifyCompletion(
      {
        v: 11,
        instanceId: 'test',
        runId: 'run',
        type: task === 'explore-phrase' ? 'explore_phrase_result' : 'explore_vocabulary_result',
        result: { attempts: 1, acceptedCount: 10 }
      },
      ''
    )
    expect(verifyCompletion).toHaveBeenCalledWith({ attempts: 1, acceptedCount: 10 })
  }
)

it.each(['sentence-practice-hints', 'sentence-practice-review'] as const)(
  '%s refuses a model call before preparation',
  async (task) => {
    const model = vi.fn()
    const { host } = boundHost({
      task,
      host: { prepare: () => ({ inputChars: 1 }), model, verifyCompletion: noop }
    })
    await expect(
      host.call(
        'early',
        task === 'sentence-practice-hints'
          ? 'model.sentence-practice-hints'
          : 'model.sentence-practice-review',
        { systemPrompt: 'English' },
        noop,
        signal()
      )
    ).rejects.toMatchObject({ code: 'AGENT_PROTOCOL_ERROR' })
    expect(model).not.toHaveBeenCalled()
  }
)

it.each(['sentence-practice-hints', 'sentence-practice-review'] as const)(
  '%s prepares and returns its own receipt and completion',
  async (task) => {
    const model = vi.fn(async () => ({ completed: true as const }))
    const verifyCompletion = vi.fn()
    const { host, binding } = boundHost({
      task,
      host: { prepare: () => ({ inputChars: 100 }), model, verifyCompletion }
    })
    const abort = signal()
    await host.call('prepare', 'sentence-practice.prepare', {}, noop, abort)
    const args = { systemPrompt: 'Explain in Chinese, examples in English.' }
    await expect(
      host.call(
        'model',
        task === 'sentence-practice-hints'
          ? 'model.sentence-practice-hints'
          : 'model.sentence-practice-review',
        args,
        noop,
        abort
      )
    ).resolves.toEqual({ completed: true })
    expect(model).toHaveBeenCalledExactlyOnceWith(args, abort, 65536)
    binding.adapter.verifyCompletion(
      {
        v: 11,
        instanceId: 'test',
        runId: 'run',
        type: 'sentence_practice_result',
        result: { completed: true }
      },
      ''
    )
    expect(verifyCompletion).toHaveBeenCalledWith({ completed: true })
  }
)

it('forwards synonym index, round and authorized action without reconstructing its domain ledger', async () => {
  const model = vi.fn(async () => ({
    inputIndex: 0,
    round: 1,
    kind: 'tool' as const,
    inputChars: 100
  }))
  const apply = vi.fn(() => ({ inputIndex: 0, round: 1, kind: 'terminal' as const }))
  const finish = vi.fn(() => ({ inputIndex: 0, stop: false }))
  const verifyCompletion = vi.fn()
  const { host, binding } = boundHost({
    task: 'synonym',
    host: {
      prepare: () => ({ items: [{ inputIndex: 0, status: 'pending' }] }),
      model,
      apply,
      finish,
      verifyCompletion
    }
  })
  const abort = signal()
  await host.call('prepare', 'synonym.prepare', {}, noop, abort)
  const args = { inputIndex: 0, round: 1, systemPrompt: 'Explain in Chinese.' }
  await host.call('model', 'model.synonym', args, noop, abort)
  await host.call(
    'apply',
    'synonym.apply',
    { inputIndex: 0, round: 1, action: 'execute' },
    noop,
    abort
  )
  await host.call(
    'finish',
    'synonym.finish',
    { inputIndex: 0, round: 1, reason: 'terminal' },
    noop,
    abort
  )
  expect(model).toHaveBeenCalledExactlyOnceWith(args, abort, 65536)
  expect(apply).toHaveBeenCalledExactlyOnceWith(
    { inputIndex: 0, round: 1, action: 'execute' },
    abort
  )
  expect(finish).toHaveBeenCalledExactlyOnceWith({ inputIndex: 0, round: 1, reason: 'terminal' })
  binding.adapter.verifyCompletion(
    {
      v: 11,
      instanceId: 'test',
      runId: 'run',
      type: 'synonym_result',
      result: { completedIndices: [0] }
    },
    ''
  )
  expect(verifyCompletion).toHaveBeenCalledWith({ completedIndices: [0] })
})

it('forwards practice correction instructions and round-bound receipts to the existing host', async () => {
  const model = vi.fn(async () => ({ round: 1, kind: 'missing_marks' as const, inputChars: 100 }))
  const apply = vi.fn(() => ({ round: 1, applied: true as const }))
  const correct = vi.fn(() => ({ round: 1, applied: true as const }))
  const finish = vi.fn(() => ({ completed: true as const, rounds: 1 }))
  const verifyCompletion = vi.fn()
  const { host, binding } = boundHost({
    task: 'vocabulary-practice-review',
    host: { prepare: () => ({ inputChars: 100 }), model, apply, correct, finish, verifyCompletion }
  })
  const abort = signal()
  await host.call('prepare', 'vocabulary-practice.prepare', {}, noop, abort)
  const args = { round: 1, systemPrompt: 'Feedback in Chinese.' }
  await host.call('model', 'model.vocabulary-practice-review', args, noop, abort)
  await host.call('apply', 'vocabulary-practice.apply', { round: 1 }, noop, abort)
  await host.call(
    'correct',
    'vocabulary-practice.correct',
    { round: 1, instruction: 'Mark answers in English.' },
    noop,
    abort
  )
  await host.call(
    'finish',
    'vocabulary-practice.finish',
    { round: 1, reason: 'terminal' },
    noop,
    abort
  )
  expect(model).toHaveBeenCalledExactlyOnceWith(args, abort, 65536)
  expect(apply).toHaveBeenCalledExactlyOnceWith({ round: 1 }, abort)
  expect(correct).toHaveBeenCalledExactlyOnceWith(
    { round: 1, instruction: 'Mark answers in English.' },
    abort
  )
  expect(finish).toHaveBeenCalledExactlyOnceWith({ round: 1, reason: 'terminal' })
  binding.adapter.verifyCompletion(
    {
      v: 11,
      instanceId: 'test',
      runId: 'run',
      type: 'vocabulary_practice_result',
      result: { completed: true, rounds: 1 }
    },
    ''
  )
  expect(verifyCompletion).toHaveBeenCalledWith({ completed: true, rounds: 1 })
})

it('reserves the non-model budget before running a domain action', async () => {
  const apply = vi.fn()
  const { host } = boundHost(
    {
      task: 'synonym',
      host: { prepare: vi.fn(), model: vi.fn(), apply, finish: vi.fn(), verifyCompletion: noop }
    },
    (snapshot) => {
      snapshot.budget.maxToolCalls = 0
    }
  )
  await expect(
    host.call(
      'apply',
      'synonym.apply',
      { inputIndex: 0, round: 1, action: 'execute' },
      noop,
      signal()
    )
  ).rejects.toMatchObject({ code: 'AGENT_LIMIT' })
  expect(apply).not.toHaveBeenCalled()
})

it('keeps malformed operation arguments a protocol error before reserving a spent budget', async () => {
  const apply = vi.fn()
  const { host } = boundHost(
    {
      task: 'synonym',
      host: { prepare: vi.fn(), model: vi.fn(), apply, finish: vi.fn(), verifyCompletion: noop }
    },
    (snapshot) => {
      snapshot.budget.maxToolCalls = 0
    }
  )
  await expect(
    host.call('apply', 'synonym.apply', { round: 1, action: 'execute' }, noop, signal())
  ).rejects.toMatchObject({ code: 'AGENT_PROTOCOL_ERROR' })
  expect(apply).not.toHaveBeenCalled()
})
