import { randomUUID, randomBytes, createHash } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { openDatabase } from '../../../database/database'
import { SqliteCommunicationRepository } from '../../../database/sqlite-communication-repository'
import type { CommunicationAdapter } from '../communication-adapter'
import type { InboundEvent, Receipt } from '../communication-contract'
import { CommunicationService } from '../communication-service'

// Future adapters supply only transport injection and observed sends. No binding,
// queueing or execution logic belongs in their harness.
export interface AdapterContractHarness {
  adapter: CommunicationAdapter
  inject(event: InboundEvent, cursor?: string): Promise<Receipt>
  sentTexts(): string[]
}
export function runCommunicationAdapterContract(
  name: string,
  makeHarness: () => AdapterContractHarness,
  options?: { sessionCursor?: boolean }
): void {
  describe(`communication adapter: ${name}`, () => {
    const cleanups: Array<() => Promise<void>> = []
    afterEach(async () => {
      for (const cleanup of cleanups.splice(0)) await cleanup()
    })
    it('shares durable admission, binding, deduplication, final projection and stopped-generation rules', async () => {
      const db = openDatabase(':memory:')
      const harness = makeHarness()
      const execute = vi.fn(async () => ({ status: 'succeeded' as const, text: 'Final answer' }))
      const service = new CommunicationService(
        new SqliteCommunicationRepository(db),
        {
          async createSession(id) {
            const now = new Date().toISOString()
            db.prepare('INSERT INTO conversations VALUES (?, ?, ?, ?)').run(
              id,
              now,
              now,
              'Contract'
            )
          },
          execute,
          recover: async () => undefined,
          cancel: vi.fn()
        },
        {
          now: Date.now,
          id: randomUUID,
          secret: () => randomBytes(16).toString('hex'),
          digest: (value) => createHash('sha256').update(value).digest('hex'),
          languages: () => ({ uiLanguage: 'en', outputLanguage: 'en', targetLanguage: 'en' }),
          diagnostics: vi.fn()
        }
      )
      cleanups.push(async () => {
        await service.shutdown()
        db.close()
      })
      service.registerAdapter('contract', () => harness.adapter, options)
      const connectionId = service.addConnection('contract')
      await expect(service.start(connectionId)).resolves.toBeUndefined()
      const event = (text: string): InboundEvent => ({
        type: 'text',
        text,
        externalEventId: randomUUID(),
        externalMessageId: randomUUID(),
        externalActorId: 'actor',
        externalConversationId: 'private-chat',
        scope: 'private',
        occurredAt: Date.now()
      })
      expect((await harness.inject(event('unbound'))).code).toBe('UNBOUND')
      const challenge = service.createChallenge(connectionId, ['chat'])
      expect((await harness.inject(event(`/bind ${challenge.code}`))).status).toBe('persisted')
      service.confirmBinding(challenge.challengeId)
      const input = event('hello')
      const receipt = await harness.inject(input, 'opaque-cursor')
      expect(receipt.status).toBe('persisted')
      expect(await harness.inject(input, 'opaque-cursor')).toEqual(receipt)
      expect((await harness.inject(event('/vocabulary denied'))).code).toBe('CAPABILITY_DENIED')
      await service.flush()
      expect(execute).toHaveBeenCalledTimes(1)
      expect(harness.sentTexts().join('')).toContain('Final answer')
      await service.stop(connectionId)
      expect((await harness.inject(event('late'))).status).toBe('failed')
      expect(execute).toHaveBeenCalledTimes(1)
    })
  })
}
