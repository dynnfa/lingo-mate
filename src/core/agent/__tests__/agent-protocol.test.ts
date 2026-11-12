import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { agentFrameSchema, AGENT_PROTOCOL_VERSION } from '../agent-protocol'

it('accepts bound synonym turns and completion without exposing tool arguments', () => {
  const base = { v: AGENT_PROTOCOL_VERSION, instanceId: 'p', runId: 'r', callId: 'r:c' }
  const frame = {
    ...base,
    type: 'host_call',
    operation: 'model.synonym',
    args: { inputIndex: 0, round: 1, systemPrompt: 'Explain in English' }
  }
  expect(agentFrameSchema.safeParse(frame).success).toBe(true)
  expect(
    agentFrameSchema.safeParse({ ...frame, args: { ...frame.args, word: 'forged' } }).success
  ).toBe(false)
  expect(
    agentFrameSchema.safeParse({
      v: base.v,
      instanceId: base.instanceId,
      runId: base.runId,
      type: 'synonym_result',
      result: { completedIndices: [0] }
    }).success
  ).toBe(true)
})

describe('agent protocol', () => {
  it('accepts a versioned handshake and rejects incompatible versions and extra authority', () => {
    const frame = { v: AGENT_PROTOCOL_VERSION, instanceId: 'process-1', type: 'hello' }
    expect(agentFrameSchema.parse(frame)).toEqual(frame)
    expect(agentFrameSchema.safeParse({ ...frame, v: 99 }).success).toBe(false)
    expect(agentFrameSchema.safeParse({ ...frame, apiKey: 'secret' }).success).toBe(false)
  })
})

const cases: Array<{ name: string; valid: boolean; frame: unknown }> = JSON.parse(
  readFileSync(resolve('tests/integration/fixtures/agent/protocol-cases.json'), 'utf8')
)
it.each(cases)('$name obeys the shared wire contract', ({ valid, frame }) => {
  expect(agentFrameSchema.safeParse(frame).success).toBe(valid)
})

it('supports bounded vocabulary calls and completion markers without accepting outer identities', () => {
  const base = { v: AGENT_PROTOCOL_VERSION, instanceId: 'p', runId: 'r', callId: 'r:c' }
  const call = {
    ...base,
    type: 'host_call',
    operation: 'model.vocabulary',
    args: { inputIndex: 19, systemPrompt: 'Explain in English.' }
  }
  expect(agentFrameSchema.safeParse(call).success).toBe(true)
  expect(
    agentFrameSchema.safeParse({ ...call, args: { ...call.args, inputIndex: 20 } }).success
  ).toBe(false)
  expect(
    agentFrameSchema.safeParse({ ...call, args: { ...call.args, term: 'replacement' } }).success
  ).toBe(false)
  expect(
    agentFrameSchema.safeParse({ ...call, args: { ...call.args, executionId: 'outer' } }).success
  ).toBe(false)
  expect(
    agentFrameSchema.safeParse({
      v: AGENT_PROTOCOL_VERSION,
      instanceId: 'p',
      runId: 'r',
      type: 'vocabulary_result',
      result: { completedIndices: [0, 1] }
    }).success
  ).toBe(true)
})

it('supports bounded phrase calls and completion markers without accepting outer identities', () => {
  const base = { v: AGENT_PROTOCOL_VERSION, instanceId: 'p', runId: 'r', callId: 'r:c' }
  const call = {
    ...base,
    type: 'host_call',
    operation: 'model.phrase',
    args: { inputIndex: 19, systemPrompt: 'Explain in English.' }
  }
  expect(agentFrameSchema.safeParse(call).success).toBe(true)
  expect(
    agentFrameSchema.safeParse({ ...call, args: { ...call.args, inputIndex: 20 } }).success
  ).toBe(false)
  expect(
    agentFrameSchema.safeParse({ ...call, args: { ...call.args, phrase: 'replacement' } }).success
  ).toBe(false)
  expect(
    agentFrameSchema.safeParse({ ...call, args: { ...call.args, executionId: 'outer' } }).success
  ).toBe(false)
  expect(
    agentFrameSchema.safeParse({
      v: AGENT_PROTOCOL_VERSION,
      instanceId: 'p',
      runId: 'r',
      type: 'phrase_result',
      result: { completedIndices: [0, 1] }
    }).success
  ).toBe(true)
})

it('supports bound exploration attempts without accepting host data overrides', () => {
  const frame = {
    v: AGENT_PROTOCOL_VERSION,
    instanceId: 'p',
    runId: 'r',
    callId: 'r:c',
    type: 'host_call',
    operation: 'model.explore-phrase',
    args: { attempt: 1, systemPrompt: 'Explain in English.' }
  }
  expect(agentFrameSchema.safeParse(frame).success).toBe(true)
  for (const extra of [
    { count: 1 },
    { excludedPhrases: [] },
    { sessionId: 'outer' },
    { attempt: 4 }
  ]) {
    expect(
      agentFrameSchema.safeParse({ ...frame, args: { ...frame.args, ...extra } }).success
    ).toBe(false)
  }
})

it('supports bound vocabulary exploration attempts without accepting host data overrides', () => {
  const frame = {
    v: AGENT_PROTOCOL_VERSION,
    instanceId: 'p',
    runId: 'r',
    callId: 'r:c',
    type: 'host_call',
    operation: 'model.explore-vocabulary',
    args: { attempt: 1, systemPrompt: 'Explain in English.' }
  }
  expect(agentFrameSchema.safeParse(frame).success).toBe(true)
  for (const extra of [
    { count: 1 },
    { excludedTerms: [] },
    { sessionId: 'outer' },
    { attempt: 4 }
  ]) {
    expect(
      agentFrameSchema.safeParse({ ...frame, args: { ...frame.args, ...extra } }).success
    ).toBe(false)
  }
})

it('accepts only a single typed conversation route and a bounded classification receipt', () => {
  const base = { v: AGENT_PROTOCOL_VERSION, instanceId: 'p', runId: 'r' }
  const terminal = { ...base, type: 'conversation_route_result' }
  expect(
    agentFrameSchema.safeParse({
      ...terminal,
      result: { kind: 'workflow', workflow: 'tts' }
    }).success
  ).toBe(true)
  for (const result of [
    { kind: 'workflow', workflow: 'conversation-title' },
    { kind: 'reply', workflow: 'sentence' },
    { kind: 'invalid', workflow: 'concept' },
    [{ kind: 'reply' }, { kind: 'workflow', workflow: 'tts' }]
  ]) {
    expect(agentFrameSchema.safeParse({ ...terminal, result }).success).toBe(false)
  }
  const receipt = { ...base, type: 'host_result', callId: 'r:c' }
  expect(agentFrameSchema.safeParse({ ...receipt, result: { intent: 'unclear' } }).success).toBe(
    true
  )
  expect(agentFrameSchema.safeParse({ ...receipt, result: { intent: 'sentence' } }).success).toBe(
    false
  )
})
