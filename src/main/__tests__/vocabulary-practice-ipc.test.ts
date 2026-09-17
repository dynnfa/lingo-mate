import { beforeEach, describe, expect, it, vi } from 'vitest'
import { VocabularyError } from '../../core/learning/vocabulary/parse-vocabulary-input'
import { VocabularyPracticeError } from '../../core/learning/vocabulary-practice/parse-vocabulary-practice-input'
import {
  VOCABULARY_PRACTICE_CHANNELS,
  type VocabularyPracticeCancelResult,
  type VocabularyPracticeReviewResult,
  type VocabularyPracticeStartResult
} from '../../shared/vocabulary-practice'
import {
  registerVocabularyPracticeIpc,
  toSafeVocabularyPracticeError
} from '../vocabulary-practice-ipc'
import { createTrustedHandlerRegistrar } from '../ipc-guard'
import {
  electronMocks,
  FakeSender,
  registeredHandler,
  RENDERER_URL,
  resetIpcMocks
} from './helpers/ipc-test-env'

vi.mock('electron', async () => (await import('./helpers/ipc-test-env')).electronTestModule())

const registerTrustedHandler = createTrustedHandlerRegistrar({ rendererUrl: RENDERER_URL })

const START_INPUT = { requestId: '11111111-1111-4111-8111-111111111111', count: 10 }
const SESSION_ID = '22222222-2222-4222-8222-222222222222'
const ENTRY_ID = '33333333-3333-4333-8333-333333333333'

function fakeService(
  overrides: Partial<{
    start: (count: number) => unknown
    review: (sessionId: string, answers: unknown[], language: string) => Promise<unknown>
    cancel: (sessionId: string) => boolean
  }> = {}
): {
  start: ReturnType<typeof vi.fn>
  review: ReturnType<typeof vi.fn>
  cancel: ReturnType<typeof vi.fn>
} {
  return {
    start: vi.fn(
      overrides.start ??
        (() => ({
          sessionId: SESSION_ID,
          requestedCount: 10,
          entries: [{ entryId: ENTRY_ID, term: 'apple' }]
        }))
    ),
    review: vi.fn(
      overrides.review ??
        (async () => ({
          verdict: 'all_correct',
          summary: '全部正确。',
          marks: []
        }))
    ),
    cancel: vi.fn(overrides.cancel ?? (() => true))
  }
}

function register(
  service: ReturnType<typeof fakeService> = fakeService()
): ReturnType<typeof fakeService> {
  registerVocabularyPracticeIpc(service as never, () => 'zh-CN', registerTrustedHandler)
  return service
}

beforeEach(resetIpcMocks)

describe('vocabulary practice IPC', () => {
  it('rejects untrusted callers before touching the service', async () => {
    const service = register()
    const start = registeredHandler(VOCABULARY_PRACTICE_CHANNELS.start)
    const review = registeredHandler(VOCABULARY_PRACTICE_CHANNELS.review)
    const cancel = registeredHandler(VOCABULARY_PRACTICE_CHANNELS.cancel)

    const foreign = new FakeSender()
    foreign.owned = false
    const navigated = new FakeSender()
    navigated.mainFrame = { url: 'https://untrusted.invalid/' }
    const destroyed = new FakeSender()
    destroyed.destroyed = true
    const subFrame = new FakeSender()

    for (const sender of [foreign, navigated, destroyed]) {
      expect(await start({ sender }, START_INPUT)).toEqual({
        status: 'error',
        error: { code: 'UNTRUSTED_SOURCE' }
      })
      expect(await review({ sender }, {})).toEqual({
        status: 'error',
        error: { code: 'UNTRUSTED_SOURCE' }
      })
      expect(await cancel({ sender }, {})).toEqual({
        status: 'error',
        error: { code: 'UNTRUSTED_SOURCE' }
      })
    }
    expect(
      await start({ sender: subFrame, senderFrame: { url: RENDERER_URL } }, START_INPUT)
    ).toEqual({ status: 'error', error: { code: 'UNTRUSTED_SOURCE' } })
    expect(service.start).not.toHaveBeenCalled()
    expect(service.review).not.toHaveBeenCalled()
    expect(service.cancel).not.toHaveBeenCalled()
  })

  it('rejects inputs outside the predefined window', async () => {
    const service = register()
    const start = registeredHandler(VOCABULARY_PRACTICE_CHANNELS.start)
    const review = registeredHandler(VOCABULARY_PRACTICE_CHANNELS.review)
    const cancel = registeredHandler(VOCABULARY_PRACTICE_CHANNELS.cancel)
    const sender = { sender: new FakeSender() }

    for (const input of [
      { count: 0 },
      { count: 51 },
      { count: '10' },
      { requestId: 'not-a-uuid' },
      null
    ]) {
      expect(await start(sender, input === null ? null : { ...START_INPUT, ...input })).toEqual({
        status: 'error',
        error: { code: 'INVALID_INPUT' }
      })
    }
    for (const input of [
      { sessionId: SESSION_ID, answers: [] },
      { sessionId: 'apple', answers: [{ entryId: ENTRY_ID, meaning: 'x' }] },
      { answers: [{ entryId: ENTRY_ID, meaning: '' }] }
    ]) {
      expect(await review(sender, { requestId: START_INPUT.requestId, ...input })).toEqual({
        status: 'error',
        error: { code: 'INVALID_INPUT' }
      })
    }
    expect(await cancel(sender, { sessionId: 'apple' })).toEqual({
      status: 'error',
      error: { code: 'INVALID_INPUT' }
    })
    expect(service.start).not.toHaveBeenCalled()
    expect(service.review).not.toHaveBeenCalled()
    expect(service.cancel).not.toHaveBeenCalled()
  })

  it('starts a round with the validated count for trusted callers', async () => {
    const service = register()
    const result = (await registeredHandler(VOCABULARY_PRACTICE_CHANNELS.start)(
      { sender: new FakeSender() },
      START_INPUT
    )) as VocabularyPracticeStartResult
    expect(result).toEqual({
      status: 'ok',
      sessionId: SESSION_ID,
      requestedCount: 10,
      actualCount: 1,
      entries: [{ entryId: ENTRY_ID, term: 'apple' }]
    })
    expect(service.start).toHaveBeenCalledWith(10)
  })

  it('reviews with the resolved language and validates the output protocol', async () => {
    const service = register(
      fakeService({
        review: async (_sessionId, answers, language) => ({
          verdict: 'has_errors',
          summary: '存在错误。',
          marks: [
            {
              entryId: (answers[0] as { entryId: string }).entryId,
              field: 'meaning',
              reason: String(language)
            }
          ]
        })
      })
    )
    const result = (await registeredHandler(VOCABULARY_PRACTICE_CHANNELS.review)(
      { sender: new FakeSender() },
      {
        requestId: START_INPUT.requestId,
        sessionId: SESSION_ID,
        answers: [{ entryId: ENTRY_ID, meaning: '答案' }]
      }
    )) as VocabularyPracticeReviewResult
    expect(result.status).toBe('ok')
    if (result.status === 'ok') {
      expect(result.verdict).toBe('has_errors')
      expect(result.marks[0].reason).toBe('zh-CN')
    }
    expect(service.review).toHaveBeenCalledWith(
      SESSION_ID,
      [{ entryId: ENTRY_ID, meaning: '答案' }],
      'zh-CN'
    )
  })

  it('maps core errors to safe codes without internals', async () => {
    const service = register(
      fakeService({
        start: () => {
          throw new VocabularyError('STORAGE_FAILED', { cause: new Error('sqlite locked') })
        }
      })
    )
    const stored = await registeredHandler(VOCABULARY_PRACTICE_CHANNELS.start)(
      { sender: new FakeSender() },
      START_INPUT
    )
    expect(stored).toEqual({ status: 'error', error: { code: 'STORAGE_FAILED' } })
    expect(JSON.stringify(stored)).not.toContain('sqlite')

    service.review.mockImplementation(async () => {
      throw new VocabularyPracticeError('MODEL_NOT_CONFIGURED')
    })
    const unconfigured = (await registeredHandler(VOCABULARY_PRACTICE_CHANNELS.review)(
      { sender: new FakeSender() },
      {
        requestId: START_INPUT.requestId,
        sessionId: SESSION_ID,
        answers: [{ entryId: ENTRY_ID, meaning: 'x' }]
      }
    )) as VocabularyPracticeReviewResult
    expect(unconfigured).toEqual({ status: 'error', error: { code: 'MODEL_NOT_CONFIGURED' } })

    service.review.mockImplementation(async () => {
      throw new Error('http://secret.internal/v1 blew up')
    })
    const unknown = (await registeredHandler(VOCABULARY_PRACTICE_CHANNELS.review)(
      { sender: new FakeSender() },
      {
        requestId: START_INPUT.requestId,
        sessionId: SESSION_ID,
        answers: [{ entryId: ENTRY_ID, meaning: 'x' }]
      }
    )) as VocabularyPracticeReviewResult
    expect(unknown).toEqual({ status: 'error', error: { code: 'UNKNOWN_ERROR' } })
    expect(JSON.stringify(unknown)).not.toContain('secret')
  })

  it('reports protocol-violating results as safe errors', async () => {
    const service = register()
    // 实际数量(2)超过请求数量(1)：出口 schema 拒绝
    service.start.mockReturnValue({
      sessionId: SESSION_ID,
      requestedCount: 1,
      entries: [
        { entryId: ENTRY_ID, term: 'x' },
        { entryId: '44444444-4444-4444-8444-444444444444', term: 'y' }
      ]
    })
    expect(
      await registeredHandler(VOCABULARY_PRACTICE_CHANNELS.start)(
        { sender: new FakeSender() },
        START_INPUT
      )
    ).toEqual({
      status: 'error',
      error: { code: 'UNKNOWN_ERROR' }
    })

    // all_correct 与标记矛盾：出口 schema 拒绝
    service.review.mockResolvedValue({
      verdict: 'all_correct',
      summary: 'ok',
      marks: [{ entryId: ENTRY_ID, field: 'meaning', reason: '矛盾' }]
    })
    expect(
      await registeredHandler(VOCABULARY_PRACTICE_CHANNELS.review)(
        { sender: new FakeSender() },
        {
          requestId: START_INPUT.requestId,
          sessionId: SESSION_ID,
          answers: [{ entryId: ENTRY_ID, meaning: 'x' }]
        }
      )
    ).toEqual({ status: 'error', error: { code: 'UNKNOWN_ERROR' } })
  })

  it('returns the cancel outcome for trusted callers', async () => {
    const service = register(fakeService({ cancel: () => false }))
    const result = (await registeredHandler(VOCABULARY_PRACTICE_CHANNELS.cancel)(
      { sender: new FakeSender() },
      { sessionId: SESSION_ID }
    )) as VocabularyPracticeCancelResult
    expect(result).toEqual({ status: 'ok', cancelled: false })
    expect(service.cancel).toHaveBeenCalledWith(SESSION_ID)
  })

  it('unregisters all handlers via the returned cleanup', () => {
    const cleanup = registerVocabularyPracticeIpc(
      fakeService() as never,
      () => 'zh-CN',
      registerTrustedHandler
    )
    expect(electronMocks.handle).toHaveBeenCalledTimes(3)
    expect(electronMocks.removeHandler).not.toHaveBeenCalled()
    cleanup()
    for (const channel of Object.values(VOCABULARY_PRACTICE_CHANNELS)) {
      expect(electronMocks.removeHandler).toHaveBeenCalledWith(channel)
    }
  })

  it('maps practice errors exhaustively', () => {
    expect(toSafeVocabularyPracticeError(new VocabularyPracticeError('CANCELLED'))).toEqual({
      code: 'CANCELLED'
    })
    expect(toSafeVocabularyPracticeError(new VocabularyError('STORAGE_FAILED'))).toEqual({
      code: 'STORAGE_FAILED'
    })
    // 领域外的 VocabularyError 不透传，避免码表外泄
    expect(toSafeVocabularyPracticeError(new VocabularyError('INVALID_INPUT'))).toEqual({
      code: 'UNKNOWN_ERROR'
    })
    expect(toSafeVocabularyPracticeError(new Error('boom'))).toEqual({ code: 'UNKNOWN_ERROR' })
    expect(toSafeVocabularyPracticeError('str')).toEqual({ code: 'UNKNOWN_ERROR' })
  })
})
