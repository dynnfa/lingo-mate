import { z } from 'zod'
export const COMMUNICATION_CHANNELS = {
  snapshot: 'communication:snapshot',
  createTelegramConnection: 'communication:createTelegramConnection',
  deleteConnection: 'communication:deleteConnection',
  start: 'communication:start',
  stop: 'communication:stop',
  createChallenge: 'communication:createChallenge',
  confirmBinding: 'communication:confirmBinding',
  revokeBinding: 'communication:revokeBinding',
  cancelRequest: 'communication:cancelRequest',
  resolveDelivery: 'communication:resolveDelivery',
  setCredential: 'communication:setCredential'
} as const
const id = z.uuid()
export const communicationErrorCodeSchema = z.enum([
  'UNTRUSTED_SOURCE',
  'INVALID_INPUT',
  'COMMUNICATION_FAILED',
  'CREDENTIAL_STORAGE_UNAVAILABLE',
  'TELEGRAM_DUPLICATE_BOT',
  'TELEGRAM_BOT_MISMATCH',
  'TELEGRAM_UNAUTHORIZED',
  'TELEGRAM_WEBHOOK_CONFLICT',
  'TELEGRAM_POLL_CONFLICT',
  'TELEGRAM_CURSOR_INVALID',
  'TELEGRAM_INVALID_RESPONSE',
  'TELEGRAM_NETWORK',
  'TELEGRAM_RESPONSE_TOO_LARGE',
  'TELEGRAM_RATE_LIMITED',
  'TELEGRAM_REJECTED',
  'TELEGRAM_NOT_SENT',
  'TELEGRAM_ADMISSION_FAILED',
  'CONNECTION_STOP_FAILED',
  'CONNECTION_FAILED',
  'CONNECTION_LOST',
  'CONNECTION_LIMIT'
])
export const communicationErrorSchema = z.strictObject({ code: communicationErrorCodeSchema })
export const telegramTokenSchema = z
  .string()
  .min(20)
  .max(256)
  .regex(/^[1-9][0-9]{4,19}:[A-Za-z0-9_-]{20,200}$/u)
export const createTelegramInputSchema = z.strictObject({ token: telegramTokenSchema })
const error = z.strictObject({ status: z.literal('error'), error: communicationErrorSchema })
export const connectionInputSchema = z.strictObject({ connectionId: id })
export const challengeInputSchema = z.strictObject({
  connectionId: id,
  capabilities: z
    .array(z.enum(['chat', 'sentence']))
    .min(1)
    .max(2)
})
export const challengeIdInputSchema = z.strictObject({ challengeId: id })
export const bindingInputSchema = z.strictObject({ bindingId: id })
export const channelCancelInputSchema = z.strictObject({ bindingId: id, requestId: id })
export const deliveryInputSchema = z.strictObject({
  deliveryId: id,
  action: z.enum(['retry', 'suppress']),
  acknowledgeDuplicate: z.boolean().default(false)
})
export const credentialInputSchema = z.strictObject({
  connectionId: id,
  credential: z.string().min(1).max(16_384)
})
export const communicationActionResultSchema = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('ok') }),
  error
])
export const createConnectionResultSchema = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('ok'), connectionId: id }),
  error
])
export const challengeResultSchema = z.discriminatedUnion('status', [
  z.strictObject({
    status: z.literal('ok'),
    challengeId: id,
    code: z.string().max(128),
    expiresAt: z.number()
  }),
  error
])
export const communicationSnapshotSchema = z.strictObject({
  installedAdapters: z.array(z.string().max(64)).max(32).optional(),
  receipts: z
    .array(
      z.strictObject({
        id,
        connectionId: id,
        state: z.enum([
          'received',
          'queued',
          'dispatching',
          'running',
          'succeeded',
          'failed',
          'cancelled',
          'expired',
          'rejected',
          'interrupted'
        ]),
        code: z.string().max(64).optional()
      })
    )
    .max(50)
    .optional(),
  connections: z
    .array(
      z.strictObject({
        id,
        adapterId: z.string().max(64),
        state: z.enum(['stopped', 'starting', 'online', 'reconnecting', 'error', 'stopping']),
        hasCredential: z.boolean(),
        deleting: z.boolean().optional(),
        botId: z
          .string()
          .regex(/^[1-9][0-9]*$/u)
          .optional(),
        username: z
          .string()
          .regex(/^[A-Za-z0-9_]{5,32}$/u)
          .optional(),
        errorCode: communicationErrorCodeSchema.optional()
      })
    )
    .max(32),
  challenges: z
    .array(
      z.strictObject({ id, connectionId: id, actor: z.string().max(256), expiresAt: z.number() })
    )
    .max(32),
  bindings: z
    .array(
      z.strictObject({
        id,
        connectionId: id,
        externalActorId: z.string().max(256),
        capabilities: z.array(z.enum(['chat', 'sentence']))
      })
    )
    .max(256),
  requests: z
    .array(
      z.strictObject({
        requestId: id,
        bindingId: id,
        state: z.enum([
          'received',
          'queued',
          'dispatching',
          'running',
          'succeeded',
          'failed',
          'cancelled',
          'expired',
          'rejected',
          'interrupted'
        ])
      })
    )
    .max(50),
  deliveries: z
    .array(
      z.strictObject({
        id,
        connectionId: id,
        state: z.enum([
          'pending',
          'sending',
          'retry_wait',
          'sent',
          'failed',
          'uncertain',
          'suppressed'
        ])
      })
    )
    .max(50)
})
export type CommunicationSnapshot = z.infer<typeof communicationSnapshotSchema>
export const communicationSnapshotResultSchema = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('ok'), snapshot: communicationSnapshotSchema }),
  error
])
type ActionResult = z.infer<typeof communicationActionResultSchema>
export interface CommunicationApi {
  createTelegramConnection(
    input: z.infer<typeof createTelegramInputSchema>
  ): Promise<z.infer<typeof createConnectionResultSchema>>
  deleteConnection(input: z.infer<typeof connectionInputSchema>): Promise<ActionResult>
  snapshot(): Promise<z.infer<typeof communicationSnapshotResultSchema>>
  start(input: z.infer<typeof connectionInputSchema>): Promise<ActionResult>
  stop(input: z.infer<typeof connectionInputSchema>): Promise<ActionResult>
  createChallenge(
    input: z.infer<typeof challengeInputSchema>
  ): Promise<z.infer<typeof challengeResultSchema>>
  confirmBinding(input: z.infer<typeof challengeIdInputSchema>): Promise<ActionResult>
  revokeBinding(input: z.infer<typeof bindingInputSchema>): Promise<ActionResult>
  cancelRequest(input: z.infer<typeof channelCancelInputSchema>): Promise<ActionResult>
  resolveDelivery(input: z.input<typeof deliveryInputSchema>): Promise<ActionResult>
  setCredential(input: z.infer<typeof credentialInputSchema>): Promise<ActionResult>
}
