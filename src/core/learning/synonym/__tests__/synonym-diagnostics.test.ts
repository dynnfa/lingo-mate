import { describe, expect, it } from 'vitest'
import { summarizeSynonymFailure } from '../synonym-diagnostics'
import { SynonymError } from '../parse-synonym-input'

describe('summarizeSynonymFailure', () => {
  it('keeps HTTP status while excluding arbitrary provider fields and handles cyclic causes', () => {
    const provider = Object.assign(new Error('secret response'), {
      name: 'secret name',
      code: 'secret code',
      status: 401,
      headers: { authorization: 'secret key' }
    })
    const error = new SynonymError('MODEL_ERROR', { cause: provider })
    provider.cause = error
    const chain = summarizeSynonymFailure(error)
    expect(chain).toEqual([
      { type: 'SynonymError', code: 'MODEL_ERROR' },
      { type: 'Error', status: 401 }
    ])
    expect(JSON.stringify(chain)).not.toContain('secret')
  })

  it('keeps whitelisted storage and network codes on the chain', () => {
    const underlying = Object.assign(new Error('disk said no'), { code: 'SQLITE_FULL' })
    const chain = summarizeSynonymFailure(new SynonymError('STORAGE_FAILED', { cause: underlying }))
    expect(chain).toEqual([
      { type: 'SynonymError', code: 'STORAGE_FAILED' },
      { type: 'Error', code: 'SQLITE_FULL' }
    ])
  })
})
