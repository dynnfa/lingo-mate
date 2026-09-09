import { describe, expect, it, vi } from 'vitest'
import { PhraseError } from '../parse-phrase-input'
import type { DeletePhraseInput, ListPhraseInput } from '../../../../shared/phrase'
import { PhraseManagementService } from '../phrase-management'
import { content, memoryRepository } from './fixtures'

describe('PhraseManagementService', () => {
  it('validates inputs before delegating list to the repository', () => {
    const repository = memoryRepository()
    repository.list = vi.fn(() => ({ entries: [] }))
    const service = new PhraseManagementService(repository)

    expect(service.list({})).toEqual({ entries: [] })
    expect(service.list({ limit: 20 })).toEqual({ entries: [] })
    expect(repository.list).toHaveBeenCalledWith({ limit: 50 })
    expect(repository.list).toHaveBeenLastCalledWith({ limit: 20 })
    // 故意传入协议外的输入，断言服务在校验层拒绝。
    const invalidInputs: unknown[] = [
      { limit: 0 },
      { limit: 101 },
      { extra: true },
      { cursor: '' },
      { cursor: 'x'.repeat(201) }
    ]
    for (const invalid of invalidInputs) {
      expect(() => service.list(invalid as ListPhraseInput)).toThrow()
    }
    expect(repository.list).toHaveBeenCalledTimes(2)
  })

  it('returns idempotent delete outcomes by phrase key', () => {
    const repository = memoryRepository()
    repository.contents.push(content('look forward to'))
    repository.deleteByPhrase = vi.fn(repository.deleteByPhrase)
    const service = new PhraseManagementService(repository)

    expect(service.deleteByPhrase({ phrase: 'look forward to' })).toEqual({
      phrase: 'look forward to',
      deleted: true
    })
    expect(service.deleteByPhrase({ phrase: 'look forward to' })).toEqual({
      phrase: 'look forward to',
      deleted: false
    })
    expect(repository.deleteByPhrase).toHaveBeenCalledWith('look forward to')
    const invalidInputs: unknown[] = [
      { phrase: '' },
      { phrase: '   ' },
      { phrase: 'x'.repeat(201) },
      { phrase: 'look forward to', input: 'extra' },
      {}
    ]
    for (const invalid of invalidInputs) {
      expect(() => service.deleteByPhrase(invalid as DeletePhraseInput)).toThrow()
    }
  })

  it('propagates storage failures with their original cause', () => {
    const repository = memoryRepository()
    const failure = new PhraseError('STORAGE_FAILED', { cause: new Error('disk') })
    repository.list = () => {
      throw failure
    }
    repository.deleteByPhrase = () => {
      throw failure
    }
    const service = new PhraseManagementService(repository)

    expect(() => service.list({})).toThrow(failure)
    expect(() => service.deleteByPhrase({ phrase: 'look forward to' })).toThrow(failure)
  })
})
