import type { Receipt } from '../../src/core/communication/communication-contract'
import { resolve } from 'node:path'
import { randomUUID, randomBytes, createHash } from 'node:crypto'
import { expect, it, vi } from 'vitest'
import { PythonAgentProcess } from '../../src/main/agent/python-agent-process'
import { PythonAgentRuntime } from '../../src/main/agent/python-agent-runtime'
import type { LanguageModel } from '../../src/core/llm/language-model'
import { ConversationModule } from '../../src/core/conversation/conversation-module'
import { ConversationBusinessPort } from '../../src/main/communication/conversation-business-port'
import { CommunicationService } from '../../src/core/communication/communication-service'
import { qqHarness } from '../fixtures/qq'
import { telegramHarness } from '../fixtures/telegram'
import { TestAdapter } from '../../src/core/communication/__tests__/test-adapter'
import { SqliteCommunicationRepository } from '../../src/database/sqlite-communication-repository'
import { SqliteConversationRepository } from '../../src/database/sqlite-conversation-repository'
import { SqliteSentenceRepository } from '../../src/database/sqlite-sentence-repository'
import { SentenceConversationSkill } from '../../src/core/learning/sentence/sentence-conversation-skill'
import { createSentenceFeedbackFormatter } from '../../src/main/sentence-feedback'
import { openDatabase } from '../../src/database/database'

it.each([false, true, 'telegram', 'qq'] as const)(
  'uses the same durable conversation port and real Python for adapter interactive=%s',
  async (interactive) => {
    const db = openDatabase(':memory:')
    const process = new PythonAgentProcess({
      command: resolve('agent-engine/.venv/bin/python'),
      args: ['-I', '-m', 'lingo_agent']
    })
    const model = {
      streamReply: vi.fn<LanguageModel['streamReply']>(async function* () {
        yield { type: 'reasoning' as const, delta: 'PRIVATE_REASONING' }
        yield { type: 'text' as const, delta: 'Final answer' }
      })
    }
    const runtime = new PythonAgentRuntime(process, () => model)
    const wire = vi.spyOn(process, 'send')
    const repository = new SqliteConversationRepository(db)
    const translate = vi.fn(async () => 'Natural sentence.')
    const sentence = new SentenceConversationSkill(
      new SqliteSentenceRepository(db),
      () => ({ translate }),
      runtime,
      createSentenceFeedbackFormatter()
    )
    const conversations = new ConversationModule(
      repository,
      runtime,
      () => ({ outputLanguage: 'zh-CN', targetLanguage: 'en' }),
      new Map([['sentence', sentence]]),
      repository
    )
    const port = new ConversationBusinessPort(conversations, repository)
    const execute = vi.spyOn(port, 'execute')
    const communication = new SqliteCommunicationRepository(db)
    const service = new CommunicationService(communication, port, {
      now: Date.now,
      id: randomUUID,
      secret: () => randomBytes(16).toString('hex'),
      digest: (value) => createHash('sha256').update(value).digest('hex'),
      languages: () => ({ uiLanguage: 'en', outputLanguage: 'en', targetLanguage: 'en' }),
      diagnostics: vi.fn()
    })
    const telegram = interactive === 'telegram' ? telegramHarness() : undefined
    const qq = interactive === 'qq' ? qqHarness() : undefined
    const transport = qq ?? telegram
    const adapter = new TestAdapter(interactive === true)
    const adapterId = qq ? 'qq' : 'fixture'
    service.registerAdapter(adapterId, () => transport?.adapter ?? adapter, {
      startAsHelp: !!telegram,
      sessionCursor: !!qq
    })
    const connectionId = service.addConnection(adapterId)
    const receive = (
      text: string,
      externalEventId: string = randomUUID(),
      index?: string
    ): Promise<Receipt> =>
      (qq
        ? (event: Parameters<typeof qq.inject>[0]) => qq.inject(event, index)
        : (telegram?.inject ?? ((event) => adapter.receive(event))))({
        type: 'text',
        text,
        externalEventId,
        externalMessageId: externalEventId,
        externalActorId: 'PRIVATE_EXTERNAL_ACTOR',
        externalConversationId: 'PRIVATE_ROUTE',
        scope: 'private',
        occurredAt: Date.now()
      })
    try {
      await service.start(connectionId)
      if (qq) {
        const chatOnly = service.createChallenge(connectionId, ['chat'])
        await receive(`/bind ${chatOnly.code}`)
        const binding = service.confirmBinding(chatOnly.challengeId)
        expect((await receive('/sentence 未授权')).code).toBe('CAPABILITY_DENIED')
        await service.flush()
        expect(translate).not.toHaveBeenCalled()
        service.revokeBinding(binding.id)
      }
      const challenge = service.createChallenge(connectionId, ['chat', 'sentence'])
      await receive(`/bind ${challenge.code}`)
      service.confirmBinding(challenge.challengeId)
      const eventId = randomUUID()
      await receive('hello', eventId)
      const duplicate = await receive('hello', eventId, 'REFIDX_changed==')
      if (qq) expect(duplicate.code).toBe('EVENT_CONFLICT')
      await service.flush()
      await receive('/sentence 今天先这样吧。')
      await service.flush()
      expect((await receive('/vocabulary denied')).code).toBe('CAPABILITY_DENIED')
      await service.flush()
      expect(execute).toHaveBeenCalledTimes(2)
      expect(model.streamReply).toHaveBeenCalledTimes(1)
      expect(translate).toHaveBeenCalledTimes(1)
      expect(
        (transport ? transport.sentTexts() : adapter.sent.map((p) => p.text)).join('')
      ).toContain('Final answer')
      expect(
        (transport ? transport.sentTexts() : adapter.sent.map((p) => p.text)).join('')
      ).not.toContain('PRIVATE_REASONING')
      expect(JSON.stringify(wire.mock.calls)).not.toContain('PRIVATE_EXTERNAL_ACTOR')
      expect(JSON.stringify(wire.mock.calls)).not.toContain('PRIVATE_ROUTE')
      if (qq) {
        expect(qq.sent.filter((part) => part.msg_id === eventId)).toEqual([
          { content: 'Final answer', msg_type: 0, msg_id: eventId, msg_seq: 1 }
        ])
        expect(JSON.stringify(wire.mock.calls)).not.toMatch(/PRIVATE_QQ_|REFIDX/)
        expect(JSON.stringify(qq.sent)).not.toMatch(/PRIVATE_QQ_|REFIDX/)
      }
      // Domain commit / communication completion gap: recover from the report with NO model or write.
      communication.transaction((s) => {
        const i = [...s.inbox.values()].find((i) => i.request?.operation === 'sentence')!
        i.state = 'running'
        for (const [id, d] of s.outbox)
          if (d.requestId === i.request!.requestId) s.outbox.delete(id)
      })
      const count = db.prepare('SELECT count(*) AS count FROM sentence').get()
      await service.recover()
      await service.start(connectionId)
      await service.flush()
      expect(execute).toHaveBeenCalledTimes(2)
      expect(translate).toHaveBeenCalledTimes(1)
      expect(db.prepare('SELECT count(*) AS count FROM sentence').get()).toEqual(count)
      // Desktop and channel share ConversationExecutions, no additional concurrency path.
      const request = execute.mock.calls[0][0]
      const history = await repository.history(request.sessionId)
      expect(history[0].id).toBe(request.userMessageId)
      expect(history[1].id).toBe(request.assistantMessageId)
      if (qq) {
        let started = false
        model.streamReply.mockImplementationOnce(async function* ({ signal }) {
          started = true
          yield { type: 'reasoning', delta: 'PRIVATE_CANCELLED_REASONING' }
          await new Promise<void>((done) => {
            if (signal.aborted) done()
            else signal.addEventListener('abort', () => done(), { once: true })
          })
        })
        const cancelledId = randomUUID()
        await receive('cancel this question', cancelledId)
        const running = service.flush()
        await vi.waitFor(() => expect(started).toBe(true))
        await receive('/cancel')
        await running
        expect(
          communication.read(
            (s) =>
              [...s.inbox.values()].find((item) => item.event?.externalMessageId === cancelledId)
                ?.state
          )
        ).toBe('cancelled')
        expect(qq.sentTexts()).toContain('The request was cancelled.')
        expect(JSON.stringify(qq.sent)).not.toContain('PRIVATE_CANCELLED_REASONING')
        expect(execute).toHaveBeenCalledTimes(3)
      }
      expect(db.pragma('foreign_key_check')).toEqual([])
    } finally {
      await service.shutdown()
      await conversations.shutdown()
      await runtime.dispose()
      db.close()
    }
  }
)
