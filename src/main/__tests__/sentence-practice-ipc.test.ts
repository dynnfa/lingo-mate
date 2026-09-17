import { SentencePracticeService } from '../../core/learning/sentence-practice/sentence-practice-service'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { VocabularyError } from '../../core/learning/vocabulary/parse-vocabulary-input'
import { SentencePracticeError } from '../../core/learning/sentence-practice/parse-sentence-practice-input'
import {
  SENTENCE_PRACTICE_CHANNELS,
  type SentencePracticeCancelResult,
  type SentencePracticeCloseResult,
  type SentencePracticeReviewResult,
  type SentencePracticeStartResult
} from '../../shared/sentence-practice'
import { createTrustedHandlerRegistrar } from '../ipc-guard'
import { registerSentencePracticeIpc, toSafeSentencePracticeError } from '../sentence-practice-ipc'
import {
  electronMocks,
  FakeSender,
  registeredHandler,
  RENDERER_URL,
  resetIpcMocks
} from './helpers/ipc-test-env'

vi.mock('electron', async () => (await import('./helpers/ipc-test-env')).electronTestModule())

const registerTrustedHandler = createTrustedHandlerRegistrar({ rendererUrl: RENDERER_URL })

const REQUEST_ID = '11111111-1111-4111-8111-111111111111'
const SESSION_ID = '22222222-2222-4222-8222-222222222222'
const ENTRY_ID = '33333333-3333-4333-8333-333333333333'
const ENTRY_ID2 = '44444444-4444-4444-8444-444444444444'
const ENTRY_ID3 = '55555555-5555-4555-8555-555555555555'

const ENTRIES = [
  { entryId: ENTRY_ID, term: 'apple' },
  { entryId: ENTRY_ID2, term: 'banana' },
  { entryId: ENTRY_ID3, term: 'cherry' }
]

const HINTS = [
  { entryIds: [ENTRY_ID], phrase: 'eat an apple', explanation: '吃一个苹果' },
  { entryIds: [ENTRY_ID2], phrase: 'a bunch of bananas', explanation: '一串香蕉' },
  { entryIds: [ENTRY_ID3], phrase: 'ripe cherries', explanation: '成熟的樱桃' }
]

const REVIEW = {
  wordUsage: ENTRIES.map((entry) => ({
    entryId: entry.entryId,
    used: true,
    correct: true,
    feedback: '使用正确。'
  })),
  fluency: { natural: true, feedback: '整体通顺。' },
  grammar: { correct: true, issues: [] },
  summary: '全部正确。',
  revisedAnswer: null
}

function fakeService(
  overrides: Partial<{
    start: () => unknown
    generateHints: (
      sessionId: string,
      requestId: string,
      explanationLanguage: string,
      practiceLanguage: string
    ) => Promise<unknown>
    review: (
      sessionId: string,
      requestId: string,
      answer: string,
      explanationLanguage: string,
      practiceLanguage: string
    ) => Promise<unknown>
    cancel: (sessionId: string, requestId: string) => boolean
    close: (sessionId: string) => boolean
  }> = {}
): {
  start: ReturnType<typeof vi.fn>
  generateHints: ReturnType<typeof vi.fn>
  review: ReturnType<typeof vi.fn>
  cancel: ReturnType<typeof vi.fn>
  close: ReturnType<typeof vi.fn>
} {
  return {
    start: vi.fn(overrides.start ?? (() => ({ sessionId: SESSION_ID, entries: ENTRIES }))),
    generateHints: vi.fn(overrides.generateHints ?? (async () => HINTS)),
    review: vi.fn(overrides.review ?? (async () => REVIEW)),
    cancel: vi.fn(overrides.cancel ?? (() => true)),
    close: vi.fn(overrides.close ?? (() => true))
  }
}

function register(
  service: ReturnType<typeof fakeService> = fakeService()
): ReturnType<typeof fakeService> {
  registerSentencePracticeIpc(
    service as never,
    () => 'zh-CN',
    () => 'en',
    registerTrustedHandler
  )
  return service
}

beforeEach(resetIpcMocks)

describe('sentence practice IPC', () => {
  it('rejects untrusted callers before touching the service', async () => {
    const service = register()
    const channels = Object.values(SENTENCE_PRACTICE_CHANNELS)

    const foreign = new FakeSender()
    foreign.owned = false
    const navigated = new FakeSender()
    navigated.mainFrame = { url: 'https://untrusted.invalid/' }
    const destroyed = new FakeSender()
    destroyed.destroyed = true
    const subFrame = new FakeSender()

    for (const sender of [foreign, navigated, destroyed]) {
      for (const channel of channels) {
        expect(await registeredHandler(channel)({ sender }, {})).toEqual({
          status: 'error',
          error: { code: 'UNTRUSTED_SOURCE' }
        })
      }
    }
    for (const channel of channels) {
      expect(
        await registeredHandler(channel)(
          { sender: subFrame, senderFrame: { url: RENDERER_URL } },
          {}
        )
      ).toEqual({ status: 'error', error: { code: 'UNTRUSTED_SOURCE' } })
    }
    expect(service.start).not.toHaveBeenCalled()
    expect(service.generateHints).not.toHaveBeenCalled()
    expect(service.review).not.toHaveBeenCalled()
    expect(service.cancel).not.toHaveBeenCalled()
    expect(service.close).not.toHaveBeenCalled()
  })

  it('rejects inputs outside the predefined window', async () => {
    const service = register()
    const sender = { sender: new FakeSender() }
    const start = registeredHandler(SENTENCE_PRACTICE_CHANNELS.start)
    const hints = registeredHandler(SENTENCE_PRACTICE_CHANNELS.hints)
    const review = registeredHandler(SENTENCE_PRACTICE_CHANNELS.review)
    const cancel = registeredHandler(SENTENCE_PRACTICE_CHANNELS.cancel)
    const close = registeredHandler(SENTENCE_PRACTICE_CHANNELS.close)

    // start：requestId 必须是 UUID
    for (const input of [{ requestId: 'apple' }, {}, null]) {
      expect(await start(sender, input)).toEqual({
        status: 'error',
        error: { code: 'INVALID_INPUT' }
      })
    }
    // hints：requestId + sessionId
    for (const input of [{ requestId: REQUEST_ID }, { sessionId: SESSION_ID }, null]) {
      expect(await hints(sender, input)).toEqual({
        status: 'error',
        error: { code: 'INVALID_INPUT' }
      })
    }
    // review：答案去空白后须为 1-2000 字符
    for (const input of [
      { requestId: REQUEST_ID, sessionId: SESSION_ID, answer: '' },
      { requestId: REQUEST_ID, sessionId: SESSION_ID, answer: '   ' },
      { requestId: REQUEST_ID, sessionId: SESSION_ID, answer: 'a'.repeat(2001) },
      { requestId: REQUEST_ID, sessionId: 'apple', answer: 'ok' }
    ]) {
      expect(await review(sender, input)).toEqual({
        status: 'error',
        error: { code: 'INVALID_INPUT' }
      })
    }
    // cancel / close：会话与请求 ID
    expect(await cancel(sender, { sessionId: SESSION_ID })).toEqual({
      status: 'error',
      error: { code: 'INVALID_INPUT' }
    })
    expect(await close(sender, { sessionId: 'apple' })).toEqual({
      status: 'error',
      error: { code: 'INVALID_INPUT' }
    })
    expect(service.start).not.toHaveBeenCalled()
    expect(service.generateHints).not.toHaveBeenCalled()
    expect(service.review).not.toHaveBeenCalled()
    expect(service.cancel).not.toHaveBeenCalled()
    expect(service.close).not.toHaveBeenCalled()
  })

  it('starts a round for trusted callers and validates the output protocol', async () => {
    const service = register()
    const sender = new FakeSender()
    const result = (await registeredHandler(SENTENCE_PRACTICE_CHANNELS.start)(
      { sender },
      { requestId: REQUEST_ID }
    )) as SentencePracticeStartResult
    expect(result).toEqual({
      status: 'ok',
      sessionId: SESSION_ID,
      actualCount: 3,
      entries: ENTRIES
    })
    expect(service.start).toHaveBeenCalledWith()

    // 词条数量超过 3 个：出口 schema 拒绝
    service.start.mockReturnValue({ sessionId: SESSION_ID, entries: [...ENTRIES, ENTRIES[0]] })
    expect(
      await registeredHandler(SENTENCE_PRACTICE_CHANNELS.start)(
        { sender },
        { requestId: REQUEST_ID }
      )
    ).toEqual({ status: 'error', error: { code: 'UNKNOWN_ERROR' } })
  })

  it('generates hints with resolved languages and validates the output protocol', async () => {
    const service = register()
    const sender = new FakeSender()
    await registeredHandler(SENTENCE_PRACTICE_CHANNELS.start)({ sender }, { requestId: REQUEST_ID })

    const result = (await registeredHandler(SENTENCE_PRACTICE_CHANNELS.hints)(
      { sender },
      { requestId: REQUEST_ID, sessionId: SESSION_ID }
    )) as { status: string; hints?: unknown }
    expect(result.status).toBe('ok')
    expect(result.hints).toEqual(HINTS)
    expect(service.generateHints).toHaveBeenCalledWith(SESSION_ID, REQUEST_ID, 'zh-CN', 'en')

    // 提示未覆盖全部词条：出口 schema 拒绝
    service.generateHints.mockResolvedValue(HINTS.slice(0, 2))
    expect(
      await registeredHandler(SENTENCE_PRACTICE_CHANNELS.hints)(
        { sender },
        { requestId: REQUEST_ID, sessionId: SESSION_ID }
      )
    ).toEqual({ status: 'error', error: { code: 'UNKNOWN_ERROR' } })
  })

  it('reviews with the resolved languages and validates the output protocol', async () => {
    const service = register()
    const sender = new FakeSender()
    await registeredHandler(SENTENCE_PRACTICE_CHANNELS.start)({ sender }, { requestId: REQUEST_ID })

    const result = (await registeredHandler(SENTENCE_PRACTICE_CHANNELS.review)(
      { sender },
      { requestId: REQUEST_ID, sessionId: SESSION_ID, answer: '  Apple pie. ' }
    )) as SentencePracticeReviewResult
    expect(result.status).toBe('ok')
    if (result.status === 'ok') {
      expect(result.review).toEqual(REVIEW)
    }
    // 答案在入口 schema 已去首尾空白
    expect(service.review).toHaveBeenCalledWith(SESSION_ID, REQUEST_ID, 'Apple pie.', 'zh-CN', 'en')

    // 未使用却判正确：出口 schema 拒绝
    service.review.mockResolvedValue({
      ...REVIEW,
      wordUsage: REVIEW.wordUsage.map((usage, index) =>
        index === 0 ? { ...usage, used: false, correct: true } : usage
      )
    })
    expect(
      await registeredHandler(SENTENCE_PRACTICE_CHANNELS.review)(
        { sender },
        { requestId: REQUEST_ID, sessionId: SESSION_ID, answer: 'ok' }
      )
    ).toEqual({ status: 'error', error: { code: 'UNKNOWN_ERROR' } })
  })

  it('maps core errors to safe codes without internals', async () => {
    const service = register(
      fakeService({
        start: () => {
          throw new VocabularyError('STORAGE_FAILED', { cause: new Error('sqlite locked') })
        }
      })
    )
    const stored = await registeredHandler(SENTENCE_PRACTICE_CHANNELS.start)(
      { sender: new FakeSender() },
      { requestId: REQUEST_ID }
    )
    expect(stored).toEqual({ status: 'error', error: { code: 'STORAGE_FAILED' } })
    expect(JSON.stringify(stored)).not.toContain('sqlite')

    const sender = new FakeSender()
    service.start.mockReturnValue({ sessionId: SESSION_ID, entries: ENTRIES })
    await registeredHandler(SENTENCE_PRACTICE_CHANNELS.start)({ sender }, { requestId: REQUEST_ID })
    service.review.mockImplementation(async () => {
      throw new SentencePracticeError('MODEL_NOT_CONFIGURED')
    })
    const unconfigured = (await registeredHandler(SENTENCE_PRACTICE_CHANNELS.review)(
      { sender },
      { requestId: REQUEST_ID, sessionId: SESSION_ID, answer: 'x' }
    )) as SentencePracticeReviewResult
    expect(unconfigured).toEqual({ status: 'error', error: { code: 'MODEL_NOT_CONFIGURED' } })

    service.review.mockImplementation(async () => {
      throw new Error('http://secret.internal/v1 blew up')
    })
    const unknown = (await registeredHandler(SENTENCE_PRACTICE_CHANNELS.review)(
      { sender },
      { requestId: REQUEST_ID, sessionId: SESSION_ID, answer: 'x' }
    )) as SentencePracticeReviewResult
    expect(unknown).toEqual({ status: 'error', error: { code: 'UNKNOWN_ERROR' } })
    expect(JSON.stringify(unknown)).not.toContain('secret')
  })

  it('returns cancel and close outcomes for trusted callers', async () => {
    const service = register(fakeService({ cancel: () => false, close: () => false }))
    const sender = new FakeSender()
    await registeredHandler(SENTENCE_PRACTICE_CHANNELS.start)({ sender }, { requestId: REQUEST_ID })

    const cancelled = (await registeredHandler(SENTENCE_PRACTICE_CHANNELS.cancel)(
      { sender },
      { requestId: REQUEST_ID, sessionId: SESSION_ID }
    )) as SentencePracticeCancelResult
    expect(cancelled).toEqual({ status: 'ok', cancelled: false })
    expect(service.cancel).toHaveBeenCalledWith(SESSION_ID, REQUEST_ID)

    const closed = (await registeredHandler(SENTENCE_PRACTICE_CHANNELS.close)(
      { sender },
      { sessionId: SESSION_ID }
    )) as SentencePracticeCloseResult
    expect(closed).toEqual({ status: 'ok', closed: false })
    expect(service.close).toHaveBeenCalledWith(SESSION_ID)
  })

  it('closes the owned session on window destruction and permits a new owner', async () => {
    const service = register()
    const sender = new FakeSender()
    const start = registeredHandler(SENTENCE_PRACTICE_CHANNELS.start)
    await start({ sender }, { requestId: REQUEST_ID })
    expect(sender.listenerCount('destroyed')).toBe(1)
    sender.destroyed = true
    sender.emit('destroyed')
    expect(service.close).toHaveBeenCalledWith(SESSION_ID)
    expect(sender.listenerCount('destroyed')).toBe(0)
    expect(await start({ sender: new FakeSender() }, { requestId: REQUEST_ID })).toMatchObject({
      status: 'ok'
    })
  })

  it.each(['hints', 'review'] as const)(
    'aborts a real pending %s request when its window is destroyed',
    async (kind) => {
      let signal: AbortSignal | undefined
      let notifyStarted!: () => void
      const started = new Promise<void>((resolve) => {
        notifyStarted = resolve
      })
      const pending = (input: { signal: AbortSignal }): Promise<never> => {
        signal = input.signal
        notifyStarted()
        return new Promise(() => {})
      }
      const service = new SentencePracticeService(
        {
          sampleRandom: () =>
            ENTRIES.map(({ entryId, term }) => ({
              id: entryId,
              term,
              phonetic: null,
              meaning: null,
              concept: null,
              exampleSentences: null,
              createdAt: '2026-09-10T00:00:00.000Z'
            }))
        },
        () => ({ generate: kind === 'hints' ? pending : async () => HINTS }),
        () => ({ review: pending })
      )
      registerSentencePracticeIpc(
        service,
        () => 'zh-CN',
        () => 'en',
        registerTrustedHandler
      )
      const sender = new FakeSender()
      const round = (await registeredHandler(SENTENCE_PRACTICE_CHANNELS.start)(
        { sender },
        { requestId: REQUEST_ID }
      )) as SentencePracticeStartResult
      if (round.status !== 'ok') throw new Error('Expected session')
      const input = { sessionId: round.sessionId, requestId: REQUEST_ID }
      if (kind === 'review') {
        await registeredHandler(SENTENCE_PRACTICE_CHANNELS.hints)({ sender }, input)
      }
      const result = registeredHandler(SENTENCE_PRACTICE_CHANNELS[kind])(
        { sender },
        { ...input, ...(kind === 'review' ? { answer: 'apple' } : {}) }
      )
      await started
      sender.destroyed = true
      sender.emit('destroyed')
      expect(signal?.aborted).toBe(true)
      expect(await result).toEqual({ status: 'error', error: { code: 'CANCELLED' } })
      expect(service.close(round.sessionId)).toBe(false)
    }
  )

  it('prevents another trusted window from accessing or replacing the session', async () => {
    const service = register()
    const sender = new FakeSender()
    const other = { sender: new FakeSender() }
    await registeredHandler(SENTENCE_PRACTICE_CHANNELS.start)({ sender }, { requestId: REQUEST_ID })
    for (const channel of [SENTENCE_PRACTICE_CHANNELS.hints, SENTENCE_PRACTICE_CHANNELS.review]) {
      const input = {
        sessionId: SESSION_ID,
        requestId: REQUEST_ID,
        ...(channel === SENTENCE_PRACTICE_CHANNELS.review ? { answer: 'apple' } : {})
      }
      expect(await registeredHandler(channel)(other, input)).toEqual({
        status: 'error',
        error: { code: 'SESSION_NOT_FOUND' }
      })
    }
    expect(
      await registeredHandler(SENTENCE_PRACTICE_CHANNELS.start)(other, { requestId: REQUEST_ID })
    ).toEqual({ status: 'error', error: { code: 'BUSY' } })
    expect(
      await registeredHandler(SENTENCE_PRACTICE_CHANNELS.cancel)(other, {
        sessionId: SESSION_ID,
        requestId: REQUEST_ID
      })
    ).toEqual({ status: 'ok', cancelled: false })
    expect(
      await registeredHandler(SENTENCE_PRACTICE_CHANNELS.close)(other, { sessionId: SESSION_ID })
    ).toEqual({ status: 'ok', closed: false })
    expect(service.generateHints).not.toHaveBeenCalled()
    expect(service.review).not.toHaveBeenCalled()
    expect(service.cancel).not.toHaveBeenCalled()
    expect(service.close).not.toHaveBeenCalled()
  })

  it('detaches ownership on close and keeps repeated close idempotent', async () => {
    const service = register()
    const sender = new FakeSender()
    await registeredHandler(SENTENCE_PRACTICE_CHANNELS.start)({ sender }, { requestId: REQUEST_ID })
    const close = registeredHandler(SENTENCE_PRACTICE_CHANNELS.close)
    expect(await close({ sender }, { sessionId: SESSION_ID })).toEqual({
      status: 'ok',
      closed: true
    })
    expect(await close({ sender }, { sessionId: SESSION_ID })).toEqual({
      status: 'ok',
      closed: false
    })
    sender.emit('destroyed')
    expect(service.close).toHaveBeenCalledTimes(1)
    expect(sender.listenerCount('destroyed')).toBe(0)
  })

  it('unregisters all handlers via the returned cleanup', () => {
    const cleanup = registerSentencePracticeIpc(
      fakeService() as never,
      () => 'zh-CN',
      () => 'en',
      registerTrustedHandler
    )
    expect(electronMocks.handle).toHaveBeenCalledTimes(5)
    expect(electronMocks.removeHandler).not.toHaveBeenCalled()
    cleanup()
    for (const channel of Object.values(SENTENCE_PRACTICE_CHANNELS)) {
      expect(electronMocks.removeHandler).toHaveBeenCalledWith(channel)
    }
  })

  it('maps practice errors exhaustively', () => {
    expect(toSafeSentencePracticeError(new SentencePracticeError('CANCELLED'))).toEqual({
      code: 'CANCELLED'
    })
    expect(toSafeSentencePracticeError(new VocabularyError('STORAGE_FAILED'))).toEqual({
      code: 'STORAGE_FAILED'
    })
    // 领域外的 VocabularyError 不透传，避免码表外泄
    expect(toSafeSentencePracticeError(new VocabularyError('INVALID_INPUT'))).toEqual({
      code: 'UNKNOWN_ERROR'
    })
    expect(toSafeSentencePracticeError(new Error('boom'))).toEqual({ code: 'UNKNOWN_ERROR' })
    expect(toSafeSentencePracticeError('str')).toEqual({ code: 'UNKNOWN_ERROR' })
  })
})
