import { randomUUID } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { PhraseConversationSkill } from '../phrase-conversation-skill'
import { content, insertResult, memoryRepository } from './fixtures'
import type { PhraseBatch } from '../../../../shared/phrase'

const formatFeedback = (batch: PhraseBatch, language: 'zh-CN' | 'en'): string =>
  language === 'zh-CN'
    ? `新增 ${batch.counts.saved}，已有 ${batch.counts.existing}`
    : `${batch.counts.saved} added, ${batch.counts.existing} existing`

describe('PhraseConversationSkill', () => {
  it('reuses batch parsing, reports actual facts, and formats local feedback', async () => {
    const repository = memoryRepository()
    repository.contents.push(content('piece of cake'))
    const analyze = vi.fn(async ({ phrase }: { phrase: string }) => insertResult(phrase))
    const phases: string[] = []
    const skill = new PhraseConversationSkill(repository, () => ({ analyze }), formatFeedback)

    const result = await skill.run({
      requestId: randomUUID(),
      executionId: randomUUID(),
      arguments: {
        text: 'look forward to\npiece of cake\nlook forward to\nbreak even',
        wordLanguage: 'en'
      },
      explanationLanguage: 'en',
      signal: new AbortController().signal,
      onPhase: (phase) => {
        phases.push(phase)
      }
    })

    expect(result.outcome).toBe('completed')
    if (result.outcome !== 'completed') throw new Error('expected a completed report')
    if (!('counts' in result.report)) throw new Error('Unexpected synonym report')
    expect(result.report.counts).toEqual({
      total: 4,
      saved: 2,
      existing: 1,
      duplicate: 1,
      failed: 0
    })
    expect(phases).toEqual(['analyzing', 'committing', 'summarizing'])
    expect(analyze).toHaveBeenCalledTimes(2)
    expect(skill.feedback(result.report, 'en')).toBe('2 added, 1 existing')
    expect(skill.feedback(result.report, 'zh-CN')).toBe('新增 2，已有 1')
  })

  it('stops before the summarizing phase when the batch was cancelled', async () => {
    const repository = memoryRepository()
    const phases: string[] = []
    const controller = new AbortController()
    const skill = new PhraseConversationSkill(
      repository,
      () => ({
        analyze: () => new Promise(() => {})
      }),
      formatFeedback
    )
    const result = await skill.run({
      requestId: randomUUID(),
      executionId: randomUUID(),
      arguments: { text: 'look forward to', wordLanguage: 'en' },
      explanationLanguage: 'zh-CN',
      signal: controller.signal,
      onPhase: (phase) => {
        phases.push(phase)
        if (phase === 'analyzing') controller.abort()
      }
    })
    expect(result.outcome).toBe('cancelled')
    expect(phases).toEqual(['analyzing'])
    expect(repository.contents).toHaveLength(0)
  })

  it('rejects feedback payloads that do not belong to the phrase skill', async () => {
    const repository = memoryRepository()
    const skill = new PhraseConversationSkill(
      repository,
      () => ({ analyze: async () => insertResult() }),
      formatFeedback
    )
    const vocabularyReport = {
      requestId: '11111111-1111-4111-8111-111111111111',
      outcome: 'completed' as const,
      explanationLanguage: 'en' as const,
      items: [
        {
          inputIndex: 0,
          term: 'apple',
          status: 'saved' as const,
          entryId: '22222222-2222-4222-8222-222222222222'
        }
      ],
      counts: { total: 1, saved: 1, existing: 0, duplicate: 0, failed: 0 }
    }
    expect(() => skill.feedback(vocabularyReport, 'en')).toThrow(
      'Report does not match the phrase skill'
    )
  })
})
