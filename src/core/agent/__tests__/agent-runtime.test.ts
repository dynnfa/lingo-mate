import { expect, it } from 'vitest'
import { createAgentSnapshot, DEFAULT_AGENT_BUDGET } from '../agent-runtime'

it('trims a copied history within the prompt budget without splitting Unicode characters', () => {
  const remaining = DEFAULT_AGENT_BUDGET.maxInputChars - 4096
  const messages = [{ role: 'user' as const, content: '😀' + 'x'.repeat(remaining - 1) }]
  const original = structuredClone(messages)
  const snapshot = createAgentSnapshot({
    task: 'conversation',
    messages,
    outputLanguage: 'en',
    targetLanguage: 'en'
  })
  expect(snapshot.messages[0].content[0]).toBe('x')
  expect(snapshot.messages.reduce((n, m) => n + m.content.length, 4096)).toBeLessThanOrEqual(
    DEFAULT_AGENT_BUDGET.maxInputChars
  )
  expect(messages).toEqual(original)
})

it('gives exploration its own bounded operations without forwarding business messages', () => {
  const snapshot = createAgentSnapshot({
    task: 'explore-phrase',
    messages: [{ role: 'user', content: 'Exploration batch' }],
    outputLanguage: 'en',
    targetLanguage: 'en'
  })
  expect(snapshot.allowedOperations).toEqual(['explore-phrase.prepare', 'model.explore-phrase'])
  expect(snapshot.budget).toEqual({
    timeoutMs: 180000,
    maxModelCalls: 3,
    maxToolCalls: 1,
    maxSteps: 8,
    maxInputChars: 65536,
    maxOutputChars: 32768
  })
})

it('gives vocabulary exploration its own bounded operations without forwarding business messages', () => {
  const snapshot = createAgentSnapshot({
    task: 'explore-vocabulary',
    messages: [{ role: 'user', content: 'Exploration batch' }],
    outputLanguage: 'en',
    targetLanguage: 'en'
  })
  expect(snapshot.allowedOperations).toEqual([
    'explore-vocabulary.prepare',
    'model.explore-vocabulary'
  ])
  expect(snapshot.budget).toEqual({
    timeoutMs: 180000,
    maxModelCalls: 3,
    maxToolCalls: 1,
    maxSteps: 8,
    maxInputChars: 65536,
    maxOutputChars: 32768
  })
})
