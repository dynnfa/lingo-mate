import type { Receipt } from '../../src/core/communication/communication-contract'
import { resolve } from 'node:path'
import { randomUUID, randomBytes, createHash } from 'node:crypto'
import { expect, it, vi } from 'vitest'
import { PythonAgentProcess } from '../../src/main/agent/python-agent-process'
import { PythonAgentRuntime } from '../../src/main/agent/python-agent-runtime'
import { ConversationModule } from '../../src/core/conversation/conversation-module'
import { ConversationBusinessPort } from '../../src/main/communication/conversation-business-port'
import { CommunicationService } from '../../src/core/communication/communication-service'
import { TestAdapter } from '../../src/core/communication/__tests__/test-adapter'
import { SqliteCommunicationRepository } from '../../src/database/sqlite-communication-repository'
import { SqliteConversationRepository } from '../../src/database/sqlite-conversation-repository'
import { SqliteSentenceRepository } from '../../src/database/sqlite-sentence-repository'
import { SentenceConversationSkill } from '../../src/core/learning/sentence/sentence-conversation-skill'
import { createSentenceFeedbackFormatter } from '../../src/main/sentence-feedback'
import { openDatabase } from '../../src/database/database'

it.each([false, true])(
  'uses the same durable conversation port and real Python for adapter interactive=%s',
  async (interactive) => {
    const db = openDatabase(':memory:')
    const process = new PythonAgentProcess({
      command: resolve('agent-engine/.venv/bin/python'),
      args: ['-I', '-m', 'lingo_agent']
    })
    const model = {
      streamReply: vi.fn(async function* () {
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
    const adapter = new TestAdapter(interactive)
    service.registerAdapter('fixture', () => adapter)
    const connectionId = service.addConnection('fixture')
    const receive = (text: string, externalEventId: string = randomUUID()): Promise<Receipt> =>
      adapter.receive({
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
      const challenge = service.createChallenge(connectionId, ['chat', 'sentence'])
      await receive(`/bind ${challenge.code}`)
      service.confirmBinding(challenge.challengeId)
      const eventId = randomUUID()
      await receive('hello', eventId)
      await receive('hello', eventId)
      await service.flush()
      await receive('/sentence 今天先这样吧。')
      await service.flush()
      expect(execute).toHaveBeenCalledTimes(2)
      expect(model.streamReply).toHaveBeenCalledTimes(1)
      expect(translate).toHaveBeenCalledTimes(1)
      expect(adapter.sent.map((p) => p.text).join('')).toContain('Final answer')
      expect(adapter.sent.map((p) => p.text).join('')).not.toContain('PRIVATE_REASONING')
      expect(JSON.stringify(wire.mock.calls)).not.toContain('PRIVATE_EXTERNAL_ACTOR')
      expect(JSON.stringify(wire.mock.calls)).not.toContain('PRIVATE_ROUTE')
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
      expect(db.pragma('foreign_key_check')).toEqual([])
    } finally {
      await service.shutdown()
      await conversations.shutdown()
      await runtime.dispose()
      db.close()
    }
  }
)
