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
