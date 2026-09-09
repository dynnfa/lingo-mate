import { describe, expect, it, vi } from 'vitest'
import { VocabularyError } from '../parse-vocabulary-input'
import type { DeleteVocabularyInput, ListVocabularyInput } from '../../../../shared/vocabulary'
import { VocabularyManagementService } from '../vocabulary-management'
import { insertCommand, memoryRepository } from './fixtures'

describe('VocabularyManagementService', () => {
  it('validates inputs before delegating list to the repository', () => {
    const repository = memoryRepository()
    repository.list = vi.fn(() => ({ entries: [] }))
    const service = new VocabularyManagementService(repository)

    expect(service.list({})).toEqual({ entries: [] })
    expect(service.list({ limit: 20 })).toEqual({ entries: [] })
    expect(repository.list).toHaveBeenCalledWith({ limit: 50 })
    expect(repository.list).toHaveBeenLastCalledWith({ limit: 20 })
    // 故意传入协议外的输入，断言服务在校验层拒绝。
    const invalidInputs: unknown[] = [{ limit: 0 }, { limit: 101 }, { extra: true }, { cursor: {} }]
    for (const invalid of invalidInputs) {
      expect(() => service.list(invalid as ListVocabularyInput)).toThrow()
    }
    expect(repository.list).toHaveBeenCalledTimes(2)
  })

  it('returns idempotent delete outcomes by record id', () => {
    const repository = memoryRepository()
    repository.saveBatch([insertCommand('apple')])
    repository.deleteById = vi.fn(repository.deleteById)
    const service = new VocabularyManagementService(repository)

    const existingId = repository.commands[0]?.parameters.id as string
    expect(service.deleteById({ id: existingId })).toEqual({ id: existingId, deleted: true })
    expect(service.deleteById({ id: existingId })).toEqual({ id: existingId, deleted: false })
    expect(repository.deleteById).toHaveBeenCalledWith(existingId)
    const invalidInputs: unknown[] = [{ id: 'not-a-uuid' }, { id: existingId, term: 'apple' }, {}]
    for (const invalid of invalidInputs) {
      expect(() => service.deleteById(invalid as DeleteVocabularyInput)).toThrow()
    }
  })

  it('propagates storage failures with their original cause', () => {
    const repository = memoryRepository()
    const failure = new VocabularyError('STORAGE_FAILED', { cause: new Error('disk') })
    repository.list = () => {
      throw failure
    }
    repository.deleteById = () => {
      throw failure
    }
    const service = new VocabularyManagementService(repository)

    expect(() => service.list({})).toThrow(failure)
    expect(() => service.deleteById({ id: '11111111-1111-4111-8111-111111111111' })).toThrow(
      failure
    )
  })
})
