import { describe, expect, it, vi } from 'vitest'
import type { VocabularyMistakeRepository } from '../vocabulary-mistake-repository'
import { VocabularyMistakeQueryService } from '../vocabulary-mistake-query-service'

const UUID = '11111111-1111-4111-8111-111111111111'
const STAMP = '2026-09-20T00:00:00.000Z'

const LIST_PAGE = {
  entries: [
    {
      entryId: UUID,
      term: 'apple',
      lastSubmittedMeaning: '一种水果',
      totalMistakes: 1,
      lastErrorAt: STAMP
    }
  ]
}

const HISTORY_PAGE = { items: [{ id: UUID, submittedMeaning: '一种水果', createdAt: STAMP }] }

function service(): {
  query: VocabularyMistakeQueryService
  repository: VocabularyMistakeRepository
} {
  const repository: VocabularyMistakeRepository = {
    saveBatch: vi.fn(),
    list: vi.fn(() => LIST_PAGE),
    listHistory: vi.fn(() => HISTORY_PAGE)
  }
  return { query: new VocabularyMistakeQueryService(repository), repository }
}

describe('vocabulary mistake query service', () => {
  it('validates input and delegates list queries to the repository', () => {
    const { query, repository } = service()
    expect(query.list({ limit: 10 })).toBe(LIST_PAGE)
    expect(repository.list).toHaveBeenCalledWith({ limit: 10 })
    // 缺省 limit 由 schema 补全
    expect(query.list({})).toBe(LIST_PAGE)
    expect(repository.list).toHaveBeenLastCalledWith({ limit: 50 })
  })

  it('validates input and delegates history queries to the repository', () => {
    const { query, repository } = service()
    expect(query.listHistory({ entryId: UUID })).toBe(HISTORY_PAGE)
    expect(repository.listHistory).toHaveBeenCalledWith({ entryId: UUID, limit: 50 })
  })

  it('rejects malformed queries before touching the repository', () => {
    const { query, repository } = service()
    expect(() => query.list({ limit: 0 })).toThrow()
    expect(() => query.list({ cursor: { lastErrorAt: 'nope', entryId: UUID } })).toThrow()
    expect(() => query.listHistory({ entryId: 'not-a-uuid' })).toThrow()
    expect(repository.list).not.toHaveBeenCalled()
    expect(repository.listHistory).not.toHaveBeenCalled()
  })
})
