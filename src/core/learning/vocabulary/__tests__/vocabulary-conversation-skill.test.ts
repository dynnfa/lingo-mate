import { randomUUID } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import {
  VocabularyConversationSkill,
  VocabularyDescriptionError
} from '../vocabulary-conversation-skill'
import { memoryRepository, recognized, stored } from './fixtures'

describe('VocabularyConversationSkill', () => {
  it('reuses batch parsing and reports actual saved, existing, and duplicate facts', async () => {
    const repository = memoryRepository()
    repository.entries.push(stored('banana'))
    const analyze = vi.fn(async () => recognized())
    const describe = vi.fn(async () => 'Two words were added.')
    const phases: string[] = []
    const skill = new VocabularyConversationSkill(repository, () => ({
      analyzer: { analyze },
      describer: { describe }
    }))

    const result = await skill.run({
      requestId: randomUUID(),
      executionId: randomUUID(),
      arguments: { text: 'apple, banana, apple, orange', wordLanguage: 'en' },
      explanationLanguage: 'en',
      signal: new AbortController().signal,
      onPhase: (phase) => {
        phases.push(phase)
      }
    })

    expect(result.batch.counts).toEqual({
      total: 4,
      saved: 2,
      existing: 1,
      duplicate: 1,
      failed: 0
    })
    expect(phases).toEqual(['analyzing', 'committing', 'summarizing'])
    expect(analyze).toHaveBeenCalledTimes(2)
    expect(describe).toHaveBeenCalledWith(
      expect.objectContaining({ batch: result.batch, explanationLanguage: 'en' })
    )
  })

  it('preserves the committed batch when description fails', async () => {
    const repository = memoryRepository()
    const skill = new VocabularyConversationSkill(repository, () => ({
      analyzer: { analyze: async () => recognized() },
      describer: { describe: async () => Promise.reject(new Error('provider detail')) }
    }))

    const error = await skill
      .run({
        requestId: randomUUID(),
        executionId: randomUUID(),
        arguments: { text: 'apple', wordLanguage: 'en' },
        explanationLanguage: 'zh-CN',
        signal: new AbortController().signal,
        onPhase: () => undefined
      })
      .catch((cause: unknown) => cause)

    expect(error).toBeInstanceOf(VocabularyDescriptionError)
    expect((error as VocabularyDescriptionError).batch.counts.saved).toBe(1)
    expect(repository.entries.map((entry) => entry.term)).toEqual(['apple'])
  })
})
