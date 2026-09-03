import { z } from 'zod'

export const CONVERSATION_CHANNELS = {
  send: 'conversation:send',
  cancel: 'conversation:cancel',
  event: 'conversation:event'
} as const

const identifierSchema = z.string().uuid()

export const sendMessageInputSchema = z.object({
  requestId: identifierSchema,
  sessionId: identifierSchema,
  text: z.string().trim().min(1).max(4_000)
})

export const cancelMessageInputSchema = z.object({
  requestId: identifierSchema
})

export const sendMessageResultSchema = z.object({
  requestId: identifierSchema,
  accepted: z.literal(true)
})

const eventBaseSchema = z.object({
  requestId: identifierSchema,
  sessionId: identifierSchema
})

export const conversationEventSchema = z.discriminatedUnion('type', [
  eventBaseSchema.extend({ type: z.literal('started') }),
  eventBaseSchema.extend({
    type: z.literal('chunk'),
    delta: z.string()
  }),
  eventBaseSchema.extend({
    type: z.literal('completed'),
    messageId: identifierSchema
  }),
  eventBaseSchema.extend({ type: z.literal('cancelled') }),
  eventBaseSchema.extend({
    type: z.literal('failed'),
    error: z.object({
      code: z.enum(['MODEL_ERROR', 'PERSISTENCE_ERROR', 'UNKNOWN_ERROR']),
      message: z.string()
    })
  })
])

export type SendMessageInput = z.infer<typeof sendMessageInputSchema>
export type CancelMessageInput = z.infer<typeof cancelMessageInputSchema>
export type SendMessageResult = z.infer<typeof sendMessageResultSchema>
export type ConversationEvent = z.infer<typeof conversationEventSchema>

export interface ConversationApi {
  send(input: SendMessageInput): Promise<SendMessageResult>
  cancel(input: CancelMessageInput): Promise<void>
  onEvent(listener: (event: ConversationEvent) => void): () => void
}

export interface LingoMateApi {
  conversation: ConversationApi
}
