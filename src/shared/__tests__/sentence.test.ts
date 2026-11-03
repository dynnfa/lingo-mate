import { randomUUID } from 'node:crypto'
import { expect, it } from 'vitest'
import { runConversationSkillInputSchema } from '../conversation'
import { sentenceTextSchema, sentenceContentSchema } from '../sentence'
it('rejects blank and oversized sentence requests at the IPC boundary', () => {
  const request = {
    requestId: randomUUID(),
    sessionId: randomUUID(),
    skillId: 'sentence',
    arguments: { text: '  \n  ', wordLanguage: 'en' }
  }
  expect(runConversationSkillInputSchema.safeParse(request).success).toBe(false)
  expect(
    runConversationSkillInputSchema.safeParse({
      ...request,
      arguments: { text: '😀'.repeat(2001), wordLanguage: 'en' }
    }).success
  ).toBe(false)
  expect(sentenceTextSchema.parse('  First  line\nSecond Line  ')).toBe('First  line\nSecond Line')
  expect(
    sentenceContentSchema.safeParse({
      sourceText: 'text',
      targetLanguage: 'en',
      translation: '😀'.repeat(16385)
    }).success
  ).toBe(false)
})
