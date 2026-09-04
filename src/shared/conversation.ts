import { z } from 'zod'

export const CONVERSATION_CHANNELS = {
  create: 'conversation:create',
  list: 'conversation:list',
  load: 'conversation:load',
  send: 'conversation:send',
  retry: 'conversation:retry',
  cancel: 'conversation:cancel',
  event: 'conversation:event'
} as const

const identifierSchema = z.string().uuid()
const timestampSchema = z.iso.datetime()

export const conversationSummarySchema = z.object({
  sessionId: identifierSchema,
  createdAt: timestampSchema,
  updatedAt: timestampSchema
})

export const conversationMessageSchema = z.object({
  messageId: identifierSchema,
  sessionId: identifierSchema,
  role: z.enum(['user', 'assistant']),
  content: z.string(),
  createdAt: timestampSchema
})

// send 结果与 started 事件共享同一 canonical 起始载荷；
// requestId 只关联请求，messageId 才是消息身份。
export const generationStartedSchema = z.object({
  requestId: identifierSchema,
  sessionId: identifierSchema,
  userMessage: conversationMessageSchema,
  assistantMessageId: identifierSchema
})

export const sendMessageInputSchema = z.object({
  requestId: identifierSchema,
  sessionId: identifierSchema,
  text: z.string().trim().min(1).max(4_000)
})

export const retryMessageInputSchema = z.object({
  requestId: identifierSchema,
  sessionId: identifierSchema,
  userMessageId: identifierSchema
})

export const cancelMessageInputSchema = z.object({
  requestId: identifierSchema
})

export const conversationRequestErrorSchema = z.object({
  code: z.enum([
    'NOT_FOUND',
    'CONVERSATION_BUSY',
    'REQUEST_BUSY',
    'RETRY_NOT_ALLOWED',
    'REQUEST_NOT_FOUND',
    'PERSISTENCE_ERROR',
    'UNKNOWN_ERROR'
  ]),
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

const generationResultSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('ok'),
    accepted: z.literal(true),
    generation: generationStartedSchema
  }),
  z.object({ status: z.literal('error'), error: conversationRequestErrorSchema })
])

export const sendMessageResultSchema = generationResultSchema
export const retryMessageResultSchema = generationResultSchema

export const cancelMessageResultSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('ok') }),
  z.object({ status: z.literal('error'), error: conversationRequestErrorSchema })
])

const generationEventErrorSchema = z.object({
  code: z.enum(['MODEL_ERROR', 'PERSISTENCE_ERROR', 'UNKNOWN_ERROR']),
  message: z.string()
})

const eventBaseSchema = z.object({
  requestId: identifierSchema,
  sessionId: identifierSchema
})

export const conversationEventSchema = z.discriminatedUnion('type', [
  eventBaseSchema.extend({
    type: z.literal('started'),
    userMessage: conversationMessageSchema,
    assistantMessageId: identifierSchema
  }),
  eventBaseSchema.extend({
    type: z.literal('chunk'),
    messageId: identifierSchema,
    delta: z.string()
  }),
  eventBaseSchema.extend({
    type: z.literal('completed'),
    message: conversationMessageSchema
  }),
  eventBaseSchema.extend({
    type: z.literal('cancelled'),
    messageId: identifierSchema
  }),
  eventBaseSchema.extend({
    type: z.literal('failed'),
    messageId: identifierSchema.optional(),
    error: generationEventErrorSchema
  })
])

export type SendMessageInput = z.infer<typeof sendMessageInputSchema>
export type RetryMessageInput = z.infer<typeof retryMessageInputSchema>
export type CancelMessageInput = z.infer<typeof cancelMessageInputSchema>
export type SendMessageResult = z.infer<typeof sendMessageResultSchema>
export type RetryMessageResult = z.infer<typeof retryMessageResultSchema>
export type CancelMessageResult = z.infer<typeof cancelMessageResultSchema>
export type GenerationStarted = z.infer<typeof generationStartedSchema>
export type ConversationEvent = z.infer<typeof conversationEventSchema>
export type ConversationSummary = z.infer<typeof conversationSummarySchema>
export type ConversationMessage = z.infer<typeof conversationMessageSchema>
export type ConversationRequestError = z.infer<typeof conversationRequestErrorSchema>
export type CreateConversationResult = z.infer<typeof createConversationResultSchema>
export type ListConversationsResult = z.infer<typeof listConversationsResultSchema>
export type LoadConversationInput = z.infer<typeof loadConversationInputSchema>
export type LoadConversationResult = z.infer<typeof loadConversationResultSchema>
export type GenerationEventError = z.infer<typeof generationEventErrorSchema>

export interface LoadedConversation {
  conversation: ConversationSummary
  messages: ConversationMessage[]
}

// Core 接受一次生成时返回的载荷；跨进程后由 status 包裹为 ok 分支。
export interface GenerationAccepted {
  accepted: true
  generation: GenerationStarted
}

export interface ConversationApi {
  create(): Promise<CreateConversationResult>
  list(): Promise<ListConversationsResult>
  load(input: LoadConversationInput): Promise<LoadConversationResult>
  send(input: SendMessageInput): Promise<SendMessageResult>
  retry(input: RetryMessageInput): Promise<RetryMessageResult>
  cancel(input: CancelMessageInput): Promise<CancelMessageResult>
  onEvent(listener: (event: ConversationEvent) => void): () => void
}

export interface LingoMateApi {
  conversation: ConversationApi
}
