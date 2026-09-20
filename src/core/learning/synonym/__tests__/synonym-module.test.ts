import { randomUUID } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { SynonymModule } from '../synonym-module'
import type { SynonymAnalyzer } from '../synonym-analyzer'
import type { SynonymRepository } from '../synonym-repository'
import type { ConversationSkillRunInput } from '../../../conversation/conversation-skill'
import { SynonymError } from '../parse-synonym-input'

function input(controller: AbortController, text: string): ConversationSkillRunInput {
  return {
    requestId: randomUUID(),
    executionId: randomUUID(),
    sessionId: randomUUID(),
    userMessageId: randomUUID(),
    arguments: { text, wordLanguage: 'en' },
    explanationLanguage: 'en',
    signal: controller.signal,
    onPhase: vi.fn()
  }
}
function repository(): SynonymRepository {
  return {
    findExisting: () => new Map(),
    findGroups: () => ({ groups: [], nextCursor: null }),
    listGroups: () => ({ groups: [], nextCursor: null }),
    saveWord: vi.fn(),
    saveReport: vi.fn()
  }
}
describe('synonym batch interruption', () => {
  it('diagnoses the original storage cause without leaking it into logs or reports', async () => {
    const entries: Array<Record<string, unknown>> = []
    const underlying = Object.assign(new Error('secret word and API key'), {
      code: 'SQLITE_CONSTRAINT_FOREIGNKEY'
    })
    const storage = repository()
    const module = new SynonymModule(
      storage,
      () => ({
        analyze: async () => {
          throw new SynonymError('STORAGE_FAILED', { cause: underlying })
        }
      }),
      60000,
      {
        report: (entry) => {
          entries.push(entry as unknown as Record<string, unknown>)
        }
      }
    )
    const report = await module.addBatch(input(new AbortController(), 'adequate'))
    expect(entries).toEqual([
      expect.objectContaining({
        module: 'synonym',
        code: 'STORAGE_FAILED',
        context: {
          chain: [
            { type: 'SynonymError', code: 'STORAGE_FAILED' },
            { type: 'Error', code: 'SQLITE_CONSTRAINT_FOREIGNKEY' }
          ]
        }
      })
    ])
    expect(report.items[0]).toEqual({
      inputIndex: 0,
      input: 'adequate',
      word: 'adequate',
      status: 'failed',
      code: 'STORAGE_FAILED'
    })
    expect(
      JSON.stringify([entries, report, vi.mocked(storage.saveReport).mock.calls])
    ).not.toContain('secret')
  })

  it('does not diagnose ordinary cancellation as a failure', async () => {
    const entries: Array<Record<string, unknown>> = []
    const module = new SynonymModule(
      repository(),
      () => ({
        analyze: async () => {
          throw new SynonymError('CANCELLED')
        }
      }),
      60000,
      {
        report: (entry) => {
          entries.push(entry as unknown as Record<string, unknown>)
        }
      }
    )
    expect((await module.addBatch(input(new AbortController(), 'adequate'))).items[0].status).toBe(
      'cancelled'
    )
    expect(entries).toHaveLength(0)
  })
  it('cancels a queued batch immediately without calling its model', async () => {
    const active = new AbortController()
    const waiting = new AbortController()
    let started!: () => void
    const entered = new Promise<void>((resolve) => {
      started = resolve
    })
    const analyze = vi.fn<SynonymAnalyzer['analyze']>(async () => {
      started()
      await new Promise(() => {})
    })
    const module = new SynonymModule(repository(), () => ({ analyze }), 1000)
    const first = module.addBatch(input(active, 'adequate'))
    await entered
    const second = module.addBatch(input(waiting, 'decent'))
    waiting.abort()
    expect((await second).items[0].status).toBe('cancelled')
    expect(analyze).toHaveBeenCalledOnce()
    active.abort()
    await first
  })
  it('does not accept a late unrecognized result after cancellation', async () => {
    const controller = new AbortController()
    let release!: () => void
    let started!: () => void
    const entered = new Promise<void>((resolve) => {
      started = resolve
    })
    const analyze: SynonymAnalyzer['analyze'] = async ({ executor, word }) => {
      executor.execute('report_unrecognized_word', { word })
      started()
      await new Promise<void>((resolve) => {
        release = resolve
      })
    }
    const module = new SynonymModule(repository(), () => ({ analyze }))
    const task = module.addBatch(input(controller, 'unknown'))
    await entered
    controller.abort()
    const report = await task
    release()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(report.items[0].status).toBe('cancelled')
  })
})
