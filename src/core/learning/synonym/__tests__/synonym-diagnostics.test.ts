import { expect, it, vi } from 'vitest'
import { reportSynonymFailure } from '../synonym-diagnostics'
import { SynonymError } from '../parse-synonym-input'

it('keeps HTTP status while excluding arbitrary provider fields and handles cyclic causes', () => {
  const log = vi.spyOn(console, 'error').mockImplementation(() => {})
  try {
    const provider = Object.assign(new Error('secret response'), {
      name: 'secret name',
      code: 'secret code',
      status: 401,
      headers: { authorization: 'secret key' }
    })
    const error = new SynonymError('MODEL_ERROR', { cause: provider })
    provider.cause = error
    reportSynonymFailure(error)
    expect(log).toHaveBeenCalledWith('[synonym] WORD_FAILED', [
      { type: 'SynonymError', code: 'MODEL_ERROR' },
      { type: 'Error', status: 401 }
    ])
    expect(JSON.stringify(log.mock.calls)).not.toContain('secret')
  } finally {
    log.mockRestore()
  }
})
