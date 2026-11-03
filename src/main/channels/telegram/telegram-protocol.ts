import { createHash } from 'node:crypto'
import { z } from 'zod'
import type {
  InboundEvent,
  RejectedEnvelope
} from '../../../core/communication/communication-contract'
import { CommunicationError } from '../../../core/communication/communication-contract'
export const TELEGRAM_RESPONSE_BYTES = 2 * 1024 * 1024
export const TELEGRAM_UPDATE_BYTES = 256 * 1024
export { telegramTokenSchema } from '../../../shared/communication'
export const telegramIdSchema = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER)
export const telegramUpdateIdSchema = z
  .number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER - 1)
const chatIdSchema = z.number().int().min(-Number.MAX_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER)
export const botIdentitySchema = z.object({
  id: telegramIdSchema,
  is_bot: z.literal(true),
  username: z.string().regex(/^[A-Za-z0-9_]{5,32}$/u)
})
const messageSchema = z.object({
  message_id: telegramIdSchema,
  date: z
    .number()
    .int()
    .nonnegative()
    .max(Math.floor(Number.MAX_SAFE_INTEGER / 1000)),
  from: z.object({
    id: telegramIdSchema,
    is_bot: z.literal(false),
    first_name: z.string().optional(),
    last_name: z.string().optional()
  }),
  chat: z.object({ id: chatIdSchema, type: z.enum(['private', 'group', 'supergroup', 'channel']) }),
  message_thread_id: telegramIdSchema.optional(),
  is_topic_message: z.boolean().optional(),
  business_connection_id: z.unknown().optional(),
  sender_chat: z.unknown().optional(),
  text: z.string().optional()
})
const cursorSchema = z.strictObject({
  v: z.literal(1),
  botId: z.string().regex(/^[1-9][0-9]*$/u),
  offset: telegramIdSchema
})
export function makeCursor(botId: string, offset: number): string {
  return JSON.stringify(cursorSchema.parse({ v: 1, botId, offset }))
}
export function parseCursor(cursor: string | undefined, botId: string): number | undefined {
  if (cursor === undefined) return undefined
  try {
    const parsed = cursorSchema.parse(JSON.parse(cursor))
    if (parsed.botId !== botId) throw new Error()
    return parsed.offset
  } catch {
    throw new CommunicationError('TELEGRAM_CURSOR_INVALID')
  }
}
// Sort keys and exclude mutable display metadata. Only the SHA-256 reaches Core.
function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable)
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .filter(([key]) => !['first_name', 'last_name', 'username', 'language_code'].includes(key))
        .map(([key, item]) => [key, stable(item)])
    )
  return value
}
export type MappedUpdate = { updateId: number } & (
  { event: InboundEvent; rejected?: never } | { rejected: RejectedEnvelope; event?: never }
)
export function mapUpdate(raw: unknown, botUsername: string): MappedUpdate {
  const object = z
    .object({
      update_id: telegramUpdateIdSchema,
      message: z.unknown().optional(),
      edited_message: z.unknown().optional(),
      channel_post: z.unknown().optional(),
      edited_channel_post: z.unknown().optional()
    })
    .parse(raw)
  const updateId = object.update_id
  const reject = (kind: RejectedEnvelope['kind']): MappedUpdate => ({
    updateId,
    rejected: {
      externalEventId: String(updateId),
      kind,
      digest: createHash('sha256')
        .update(JSON.stringify(stable(raw)))
        .digest('hex')
    }
  })
  if (Buffer.byteLength(JSON.stringify(raw), 'utf8') > TELEGRAM_UPDATE_BYTES)
    return reject('oversized')
  const edited = object.edited_message ?? object.edited_channel_post
  const result = messageSchema.safeParse(object.message ?? edited ?? object.channel_post)
  if (!result.success) return reject('invalid')
  const m = result.data
  if (m.business_connection_id !== undefined || m.sender_chat !== undefined)
    return reject('unsupported')
  const base = {
    externalEventId: String(updateId),
    externalMessageId: String(m.message_id),
    externalActorId: String(m.from.id),
    externalConversationId: String(m.chat.id),
    externalThreadId: m.message_thread_id === undefined ? undefined : String(m.message_thread_id),
    displayName: [m.from.first_name, m.from.last_name].filter(Boolean).join(' ').slice(0, 128),
    scope:
      m.message_thread_id || m.is_topic_message
        ? ('topic' as const)
        : m.chat.type === 'private'
          ? ('private' as const)
          : ('group' as const),
    occurredAt: m.date * 1000
  }
  if (edited !== undefined)
    return { updateId, event: { ...base, type: 'unsupported', kind: 'edit' } }
  if (m.text === undefined)
    return { updateId, event: { ...base, type: 'unsupported', kind: 'attachment' } }
  if (!m.text.trim() || m.text.length > 4000) return reject('invalid')
  let text = m.text
  const command = /^(\/[a-zA-Z0-9_]+)@([a-zA-Z0-9_]+)(?=\s|$)/u.exec(text)
  if (command) {
    if (command[2].toLowerCase() !== botUsername.toLowerCase()) return reject('other-bot')
    text = command[1] + text.slice(command[0].length)
  }
  return { updateId, event: { ...base, type: 'text', text } }
}
