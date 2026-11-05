import { z } from 'zod'
import { SUPPORTED_LOCALES, targetLanguageSchema } from '../../shared/preferences'

export const LIMITS = Object.freeze({
  text: 4000,
  externalId: 256,
  cursor: 8192,
  queuePerSession: 8,
  backlog: 256,
  accountPerMinute: 20,
  connectionPerMinute: 120,
  controlsPerMinute: 20,
  controlBacklog: 32,
  controlsPerSession: 4,
  messageAgeMs: 5 * 60_000,
  futureSkewMs: 30_000,
  challengeMs: 5 * 60_000,
  challengeAttempts: 5,
  confirmationMs: 2 * 60_000,
  sessionIdleMs: 24 * 60 * 60_000,
  deliveryMs: 24 * 60 * 60_000,
  sendAttempts: 5,
  retryBaseMs: 1000,
  retryMaxMs: 60_000,
  maxParts: 64,
  reply: 65_536,
  bodyRetentionMs: 7 * 86400_000,
  tombstoneMs: 30 * 86400_000,
  shutdownMs: 3000,
  operationMs: 180_000,
  sendMs: 30_000,
  connectMs: 30_000,
  records: 10_000,
  reconnectAttempts: 5,
  maxConnections: 32
})
export const externalIdSchema = z.string().min(1).max(LIMITS.externalId)
export const capabilitySchema = z.enum(['chat', 'sentence'])
export type Capability = z.infer<typeof capabilitySchema>
export const languagesSchema = z.strictObject({
  uiLanguage: z.enum(SUPPORTED_LOCALES),
  outputLanguage: z.enum(SUPPORTED_LOCALES),
  targetLanguage: targetLanguageSchema
})
export type Languages = z.infer<typeof languagesSchema>
const eventBase = {
  externalEventId: externalIdSchema,
  externalMessageId: externalIdSchema,
  externalActorId: externalIdSchema,
  externalConversationId: externalIdSchema,
  externalThreadId: externalIdSchema.optional(),
  displayName: z.string().max(128).optional(),
  scope: z.enum(['private', 'group', 'topic']),
  occurredAt: z.number().int().nonnegative()
}
export const inboundEventSchema = z.discriminatedUnion('type', [
  z.strictObject({
    ...eventBase,
    type: z.literal('text'),
    text: z.string().trim().min(1).max(LIMITS.text)
  }),
  z.strictObject({
    ...eventBase,
    type: z.literal('interaction'),
    token: z.string().min(1).max(128)
  }),
  z.strictObject({
    ...eventBase,
    type: z.literal('unsupported'),
    kind: z.enum(['attachment', 'edit', 'delete', 'service'])
  })
])
export type InboundEvent = z.infer<typeof inboundEventSchema>
export const receiptSchema = z.strictObject({
  status: z.enum(['persisted', 'rejected', 'failed']),
  code: z.string().min(1).max(64).optional(),
  requestId: z.uuid().optional()
})
export type Receipt = z.infer<typeof receiptSchema>
export const adapterCapabilitiesSchema = z.strictObject({
  edit: z.boolean(),
  interactions: z.boolean(),
  attachments: z.boolean(),
  maxTextLength: z.number().int().min(16).max(LIMITS.reply),
  encodingVersion: z.string().min(1).max(64)
})
export type AdapterCapabilities = z.infer<typeof adapterCapabilitiesSchema>
export interface Target {
  externalActorId: string
  externalConversationId: string
  externalThreadId?: string
}
export const encodedPartSchema = z.strictObject({
  text: z.string().min(1).max(LIMITS.reply),
  format: z.enum(['plain', 'markdown']),
  // Opaque bounded platform encoding, never credentials or arbitrary SDK objects.
  payload: z.string().max(16_384).optional()
})
export type EncodedPart = z.infer<typeof encodedPartSchema>
export const sendResultSchema = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('sent'), externalMessageId: externalIdSchema }),
  z.strictObject({ status: z.literal('retry'), retryAfterMs: z.number().nonnegative().optional() }),
  z.strictObject({ status: z.literal('failed') }),
  z.strictObject({ status: z.literal('uncertain') })
])
export type SendResult = z.infer<typeof sendResultSchema>
export type ConnectionState =
  'stopped' | 'starting' | 'online' | 'reconnecting' | 'error' | 'stopping'
export type ExecutionState =
  | 'received'
  | 'queued'
  | 'dispatching'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'expired'
  | 'rejected'
  | 'interrupted'
export type DeliveryState =
  'pending' | 'sending' | 'retry_wait' | 'sent' | 'failed' | 'uncertain' | 'suppressed'
export class CommunicationError extends Error {
  constructor(
    readonly code: string,
    options?: ErrorOptions
  ) {
    super(code, options)
  }
}

// Transport-only admission. No invented actor, route, text or execution authority.
export const rejectedEnvelopeSchema = z.strictObject({
  externalEventId: externalIdSchema,
  kind: z.enum(['invalid', 'unsupported', 'oversized', 'other-bot']),
  digest: z.string().regex(/^[a-f0-9]{64}$/u)
})
export type RejectedEnvelope = z.infer<typeof rejectedEnvelopeSchema>
