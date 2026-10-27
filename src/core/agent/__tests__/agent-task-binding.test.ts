import { expect, expectTypeOf, it, vi } from 'vitest'
import { AgentHost } from '../agent-host'
import { createAgentTaskBinding, type AgentTaskBindingInput } from '../agent-task-binding'
import type { AgentSnapshot } from '../agent-protocol'
import { createAgentSnapshot, type VocabularyHostOperations } from '../agent-runtime'

it('requires the task-specific dependency shape at compile time', () => {
  expectTypeOf<AgentTaskBindingInput['task']>().toEqualTypeOf<AgentSnapshot['task']>()
  expectTypeOf<{
    task: 'tts'
    host: VocabularyHostOperations
  }>().not.toExtend<AgentTaskBindingInput>()
  expectTypeOf<{ task: 'tool-loop' }>().not.toExtend<AgentTaskBindingInput>()
  expectTypeOf<{ task: 'vocabulary' }>().not.toExtend<AgentTaskBindingInput>()
})

it('rejects a snapshot and binding task mismatch before model resolution', () => {
  const snapshot = createAgentSnapshot({
    task: 'tts',
    messages: [{ role: 'user', content: 'hello' }],
    outputLanguage: 'en',
    targetLanguage: 'en'
  })
  const resolveModel = vi.fn()
  expect(() =>
    createAgentTaskBinding(snapshot, { task: 'conversation', resolveModel })
  ).toThrowError(expect.objectContaining({ code: 'AGENT_PROTOCOL_ERROR' }))
  expect(resolveModel).not.toHaveBeenCalled()
})

it('checks the task again at the generic host entry point', () => {
  const input = {
    messages: [{ role: 'user' as const, content: 'hello' }],
    outputLanguage: 'en',
    targetLanguage: 'en'
  }
  const snapshot = createAgentSnapshot({ ...input, task: 'conversation' })
  const binding = createAgentTaskBinding(snapshot, { task: 'conversation', resolveModel: vi.fn() })
  expect(
    () => new AgentHost(createAgentSnapshot({ ...input, task: 'conversation-title' }), binding)
  ).toThrowError(expect.objectContaining({ code: 'AGENT_PROTOCOL_ERROR' }))
})
