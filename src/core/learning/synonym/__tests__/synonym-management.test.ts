import { describe, expect, it, vi } from 'vitest'
import { SynonymError } from '../parse-synonym-input'
import type { SynonymListInput } from '../../../../shared/synonym'
import { SynonymManagementService } from '../synonym-management'
import type { SynonymRepository } from '../synonym-repository'

function repository(): SynonymRepository & {
  listGroups: ReturnType<typeof vi.fn>
} {
  return {
    findExisting: vi.fn(),
    findGroups: vi.fn(),
    listGroups: vi.fn(() => ({ groups: [], nextCursor: null })),
    saveWord: vi.fn(),
    saveReport: vi.fn()
  }
}

describe('SynonymManagementService', () => {
  it('validates inputs before delegating list to the repository', () => {
    const storage = repository()
    const service = new SynonymManagementService(storage)

    expect(service.list({})).toEqual({ groups: [], nextCursor: null })
    expect(storage.listGroups).toHaveBeenCalledWith({})
    // 故意传入协议外的输入，断言服务在校验层拒绝。
    const invalid: unknown[] = [
      { cursor: 'not-a-uuid' },
      { cursor: '' },
      { extra: true },
      { limit: 5 },
      { cursor: '11111111-1111-4111-8111-111111111111', extra: 1 }
    ]
    for (const input of invalid) {
      expect(() => service.list(input as SynonymListInput)).toThrow()
    }
    expect(storage.listGroups).toHaveBeenCalledTimes(1)
  })

  it('passes a valid cursor through to the repository', () => {
    const storage = repository()
    const service = new SynonymManagementService(storage)
    const cursor = '11111111-1111-4111-8111-111111111111'

    service.list({ cursor })
    expect(storage.listGroups).toHaveBeenCalledWith({ cursor })
  })

  it('propagates storage failures with their original cause', () => {
    const storage = repository()
    const failure = new SynonymError('STORAGE_FAILED', { cause: new Error('disk') })
    storage.listGroups = vi.fn(() => {
      throw failure
    })
    const service = new SynonymManagementService(storage)

    expect(() => service.list({})).toThrow(failure)
  })
})
