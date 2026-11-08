import { createHash } from 'node:crypto'
import { z } from 'zod'
import {
  externalIdSchema,
  LIMITS,
  type InboundEvent,
  type RejectedEnvelope
} from '../../../core/communication/communication-contract'

// The send endpoint describes msg_id as valid for five minutes. Use the shorter
// window until the discrepancy with its 60-minute overview is verified live.
export const QQ_REPLY_WINDOW_MS = 5 * 60_000
export const QQ_MAX_FRAME_BYTES = 64 * 1024
export const QQ_MAX_PARTS = 4
export const QQ_PART_UNITS = 1000
export const QQ_C2C_INTENT = 1 << 25
// Dispatches listed for GROUP_AND_C2C_EVENT in the QQ gateway contract.
const qqC2cDispatchTypes = new Set([
  'C2C_MESSAGE_CREATE',
  'FRIEND_ADD',
  'FRIEND_DEL',
  'C2C_MSG_REJECT',
  'C2C_MSG_RECEIVE',
  'GROUP_AT_MESSAGE_CREATE',
  'GROUP_ADD_ROBOT',
  'GROUP_DEL_ROBOT',
  'GROUP_MSG_REJECT',
  'GROUP_MSG_RECEIVE'
])

export const qqOpenId = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/u)
// QQ dispatch IDs can contain a colon, and message IDs can contain an exclamation mark.
const qqEventId = externalIdSchema.regex(/^[A-Za-z0-9_.+/=:-]+$/u)
export const qqMessageId = externalIdSchema.regex(/^[A-Za-z0-9_.+/=!-]+$/u)
const qqMessageIndex = externalIdSchema.regex(/^[A-Za-z0-9_.+/=-]+$/u)
const sequence = z.number().int().nonnegative()
const sessionId = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/u)
export const qqCursor = z.strictObject({
  version: z.literal(1),
  appId: z.string(),
  sessionId,
  seq: sequence
})
export type QqCursor = z.infer<typeof qqCursor>
export const gatewayFrame = z.object({
  op: z.number().int().nonnegative(),
  s: sequence.optional(),
  t: z.string().max(64).optional(),
  id: z.unknown().optional(),
  d: z.unknown().optional()
})
export type GatewayFrame = z.infer<typeof gatewayFrame>
export const hello = z.object({ heartbeat_interval: z.number().int().min(1000).max(120_000) })
export const ready = z.object({ session_id: sessionId })

export function parseJson(text: string | undefined): unknown {
  if (!text) return undefined
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

const messageIdentity = z.object({ id: qqMessageId })
const textMessage = messageIdentity.extend({
  author: z.object({
    user_openid: qqOpenId,
    username: z.string().max(128).optional().catch(undefined),
    bot: z.boolean().optional()
  }),
  content: z.string().min(1),
  timestamp: z.iso.datetime({ offset: true }),
  message_type: z.literal(0),
  attachments: z.array(z.never()).optional(),
  msg_elements: z.array(z.never()).optional(),
  ark_data: z.never().optional(),
  message_scene: z.object({ ext: z.array(z.string().max(4096)).max(32).optional() }).optional(),
  group_openid: z.never().optional(),
  group_id: z.never().optional(),
  guild_id: z.never().optional(),
  channel_id: z.never().optional()
})

type Admission =
  { event: InboundEvent } | { rejected: RejectedEnvelope | undefined; validationField?: string }

const missingId = (value: unknown): boolean => value === undefined || value === null || value === ''

function idStatus(value: unknown, schema: z.ZodString): 'missing' | 'invalid' | 'valid' {
  if (missingId(value)) return 'missing'
  return schema.safeParse(value).success ? 'valid' : 'invalid'
}

function diagnosticIdValue(
  value: unknown
): string | number | boolean | null | { type: 'array' | 'object' } | undefined {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value)
  if (typeof value === 'object') return { type: Array.isArray(value) ? 'array' : 'object' }
  return undefined
}

export function dispatchMetadata(
  frame: GatewayFrame,
  validationField?: string
): {
  eventType: string
  sequence?: number
  eventIdStatus: ReturnType<typeof idStatus>
  messageIdStatus: ReturnType<typeof idStatus>
  eventIdValue?: ReturnType<typeof diagnosticIdValue>
  messageIdValue?: ReturnType<typeof diagnosticIdValue>
} {
  const { t, s, d } = frame
  const messageId = d && typeof d === 'object' && 'id' in d ? d.id : undefined
  return {
    eventType:
      t && (qqC2cDispatchTypes.has(t) || t === 'READY' || t === 'RESUMED')
        ? t
        : t
          ? 'unknown'
          : 'missing',
    sequence: s,
    eventIdStatus: idStatus(frame.id, qqEventId),
    messageIdStatus: idStatus(messageId, qqMessageId),
    ...(t === 'C2C_MESSAGE_CREATE' &&
      validationField === 'id' && {
        eventIdValue: diagnosticIdValue(frame.id),
        messageIdValue: diagnosticIdValue(messageId)
      })
  }
}

export function firstInvalidField(error: z.ZodError, schema: z.ZodObject): string | undefined {
  const field = error.issues[0]?.path[0]
  return typeof field === 'string' && Object.hasOwn(schema.shape, field) ? field : undefined
}

export function mapDispatch(frame: GatewayFrame, cursor: string): Admission {
  const message = frame.t === 'C2C_MESSAGE_CREATE'
  const parsedId = messageIdentity.safeParse(frame.d)
  const messageKey =
    message && parsedId.success ? 'qq-message:' + hash(parsedId.data.id) : undefined
  const reject = (kind: RejectedEnvelope['kind'], validationField?: string): Admission => {
    const outerId = qqEventId.safeParse(frame.id)
    const externalEventId =
      messageKey ??
      (outerId.success
        ? 'qq-dispatch:' + hash(outerId.data)
        : parsedId.success && frame.t === 'GROUP_AT_MESSAGE_CREATE'
          ? 'qq-group:' + hash(parsedId.data.id)
          : undefined) ??
      // The cursor binds the sequence to this gateway session. Use it only for rejection receipts.
      (missingId(frame.id) && frame.t && qqC2cDispatchTypes.has(frame.t)
        ? 'qq-sequence:' + hash(cursor)
        : undefined)
    return {
      rejected: externalEventId
        ? { externalEventId, kind, digest: hash(externalEventId + ':' + kind) }
        : undefined,
      validationField
    }
  }
  if (!message) return reject('unsupported')
  const parsed = textMessage.safeParse(frame.d)
  if (!parsed.success) return reject('unsupported', firstInvalidField(parsed.error, textMessage))
  if (!messageKey) return reject('unsupported')
  const data = parsed.data
  if (data.author.bot) return reject('other-bot')
  if (data.content.length > LIMITS.text) return reject('oversized')
  const occurredAt = Date.parse(data.timestamp)
  if (!Number.isSafeInteger(occurredAt) || occurredAt < 0 || !data.content.trim())
    return reject('invalid')
  const indexes = data.message_scene?.ext?.filter((entry) => entry.startsWith('msg_idx='))
  const index =
    indexes?.length === 1
      ? qqMessageIndex.safeParse(indexes[0].slice('msg_idx='.length))
      : undefined
  return {
    event: {
      type: 'text',
      // msg_idx is a reference index. Until live redelivery confirms independence,
      // events with the same d.id share one execution identity.
      externalEventId: messageKey,
      externalMessageIndex: index?.data,
      externalMessageId: data.id,
      externalActorId: data.author.user_openid,
      externalConversationId: data.author.user_openid,
      displayName: data.author.username || undefined,
      scope: 'private',
      occurredAt,
      replyExpiresAt: occurredAt + QQ_REPLY_WINDOW_MS,
      text: data.content
    }
  }
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}
