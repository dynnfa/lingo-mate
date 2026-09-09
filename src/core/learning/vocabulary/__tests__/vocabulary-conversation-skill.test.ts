import { randomUUID } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { VocabularyConversationSkill } from '../vocabulary-conversation-skill'
import { insertCommand, insertResult, memoryRepository } from './fixtures'
import type { VocabularyBatch } from '../../../../shared/vocabulary'

const formatFeedback = (batch: VocabularyBatch, language: 'zh-CN' | 'en'): string =>
  language === 'zh-CN'
    ? `新增 ${batch.counts.saved}，已有 ${batch.counts.existing}`
    : `${batch.counts.saved} added, ${batch.counts.existing} existing`

describe('VocabularyConversationSkill', () => {
  it('reuses batch parsing, reports actual facts, and formats local feedback', async () => {
    const repository = memoryRepository()
    repository.commands.push(insertCommand('banana'))
    const analyze = vi.fn(async ({ term }: { term: string }) => insertResult(term))
    const phases: string[] = []
    const skill = new VocabularyConversationSkill(
      repository,
      () => ({ analyzer: { analyze } }),
      formatFeedback
    )

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
    const skill = new VocabularyConversationSkill(
      repository,
      () => ({
        analyzer: {
          analyze: () => new Promise(() => {})
        }
      }),
      formatFeedback
    )
    const result = await skill.run({
      requestId: randomUUID(),
      executionId: randomUUID(),
      arguments: { text: 'apple', wordLanguage: 'en' },
      explanationLanguage: 'zh-CN',
      signal: controller.signal,
      onPhase: (phase) => {
        phases.push(phase)
        if (phase === 'analyzing') controller.abort()
      }
    })
    expect(result.outcome).toBe('cancelled')
    expect(phases).toEqual(['analyzing'])
    expect(repository.commands).toHaveLength(0)
  })
})
