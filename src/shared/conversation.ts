import { z } from 'zod'

export const CONVERSATION_CHANNELS = {
  create: 'conversation:create',
  list: 'conversation:list',
  load: 'conversation:load',
  send: 'conversation:send',
  cancel: 'conversation:cancel',
  event: 'conversation:event'
} as const

const identifierSchema = z.string().uuid()
const timestampSchema = z.iso.datetime()

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

export const conversationSummarySchema = z.object({
  sessionId: identifierSchema,
  createdAt: timestampSchema,
  updatedAt: timestampSchema
})

export const conversationMessageSchema = z.object({
  id: identifierSchema,
  role: z.enum(['user', 'assistant']),
  content: z.string(),
  createdAt: timestampSchema
})

export const conversationRequestErrorSchema = z.object({
  code: z.enum(['NOT_FOUND', 'PERSISTENCE_ERROR', 'UNKNOWN_ERROR']),
  message: z.string()
})

export const createConversationResultSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('ok'), conversation: conversationSummarySchema }),
  z.object({ status: z.literal('error'), error: conversationRequestErrorSchema })
])

export const listConversationsResultSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('ok'), conversations: z.array(conversationSummarySchema) }),
  z.object({ status: z.literal('error'), error: conversationRequestErrorSchema })
])

export const loadConversationInputSchema = z.object({
  sessionId: identifierSchema
})

export const loadConversationResultSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('ok'),
    conversation: conversationSummarySchema,
    messages: z.array(conversationMessageSchema)
  }),
  z.object({ status: z.literal('error'), error: conversationRequestErrorSchema })
])

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
export type ConversationSummary = z.infer<typeof conversationSummarySchema>
export type ConversationMessage = z.infer<typeof conversationMessageSchema>
export type ConversationRequestError = z.infer<typeof conversationRequestErrorSchema>
export type CreateConversationResult = z.infer<typeof createConversationResultSchema>
export type ListConversationsResult = z.infer<typeof listConversationsResultSchema>
export type LoadConversationInput = z.infer<typeof loadConversationInputSchema>
export type LoadConversationResult = z.infer<typeof loadConversationResultSchema>

export interface LoadedConversation {
  conversation: ConversationSummary
  messages: ConversationMessage[]
}

export interface ConversationApi {
  create(): Promise<CreateConversationResult>
  list(): Promise<ListConversationsResult>
  load(input: LoadConversationInput): Promise<LoadConversationResult>
  send(input: SendMessageInput): Promise<SendMessageResult>
  cancel(input: CancelMessageInput): Promise<void>
  onEvent(listener: (event: ConversationEvent) => void): () => void
}

export interface LingoMateApi {
  conversation: ConversationApi
}
