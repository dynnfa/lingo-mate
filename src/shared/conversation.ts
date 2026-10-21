import type { SynonymApi, SynonymBatch } from './synonym'
import { z } from 'zod'
import type { ModelsApi } from './models'
import type { PreferencesApi } from './preferences'
import type { UsageApi } from './usage'
import type { VocabularyApi, VocabularyBatch } from './vocabulary'
import type { PhraseApi, PhraseBatch } from './phrase'
import type { ExplorePhraseReport } from './explore-phrase'
import type { ExploreVocabularyReport } from './explore-vocabulary'
import type { VocabularyPracticeApi } from './vocabulary-practice'
import type { SentencePracticeApi } from './sentence-practice'
import type { VocabularyMistakesApi } from './vocabulary-mistakes'
import type { ErrorReportApi } from './error-report'

export const CONVERSATION_CHANNELS = {
  create: 'conversation:create',
  list: 'conversation:list',
  load: 'conversation:load',
  send: 'conversation:send',
  runSkill: 'conversation:runSkill',
  retry: 'conversation:retry',
  cancel: 'conversation:cancel',
  event: 'conversation:event'
} as const

const identifierSchema = z.string().uuid()
const timestampSchema = z.iso.datetime()

export const CONVERSATION_TITLE_MAX_LENGTH = 40

export const conversationSummarySchema = z.object({
  sessionId: identifierSchema,
  title: z.string().trim().min(1).max(CONVERSATION_TITLE_MAX_LENGTH).nullable(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema
})

export const conversationMessageSchema = z.object({
  messageId: identifierSchema,
  sessionId: identifierSchema,
  role: z.enum(['user', 'assistant']),
  content: z.string(),
  createdAt: timestampSchema,
  retryable: z.boolean().optional()
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

export const conversationSkillIdSchema = z.enum([
  'vocabulary',
  'phrase',
  'synonym',
  'explore-phrase',
  'explore-vocabulary'
])
export type ConversationSkillId = z.infer<typeof conversationSkillIdSchema>

// 会话技能参数按 skillId 判别：vocabulary/phrase/synonym 要求非空 text；
// explore-phrase 与 explore-vocabulary 是无参数命令，仅携带目标语言，
// 不为支持它们放宽 text 校验。
export const conversationSkillArgumentsSchema = z.strictObject({
  text: z.string().min(1).max(4_000),
  wordLanguage: z.literal('en')
})
export const explorePhraseSkillArgumentsSchema = z.strictObject({
  wordLanguage: z.literal('en')
})
export const exploreVocabularySkillArgumentsSchema = z.strictObject({
  wordLanguage: z.literal('en')
})

const vocabularySkillInputSchema = z.strictObject({
  requestId: identifierSchema,
  sessionId: identifierSchema,
  skillId: z.literal('vocabulary'),
  arguments: conversationSkillArgumentsSchema
})
const phraseSkillInputSchema = z.strictObject({
  requestId: identifierSchema,
  sessionId: identifierSchema,
  skillId: z.literal('phrase'),
  arguments: conversationSkillArgumentsSchema
})
const synonymSkillInputSchema = z.strictObject({
  requestId: identifierSchema,
  sessionId: identifierSchema,
  skillId: z.literal('synonym'),
  arguments: conversationSkillArgumentsSchema
})

export const runConversationSkillInputSchema = z.discriminatedUnion('skillId', [
  vocabularySkillInputSchema,
  phraseSkillInputSchema,
  synonymSkillInputSchema,
  z.strictObject({
    requestId: identifierSchema,
    sessionId: identifierSchema,
    skillId: z.literal('explore-phrase'),
    arguments: explorePhraseSkillArgumentsSchema
  }),
  z.strictObject({
    requestId: identifierSchema,
    sessionId: identifierSchema,
    skillId: z.literal('explore-vocabulary'),
    arguments: exploreVocabularySkillArgumentsSchema
  })
])

export const retryMessageInputSchema = z.object({
  requestId: identifierSchema,
  sessionId: identifierSchema,
  userMessageId: identifierSchema
})

export const cancelMessageInputSchema = z.object({
  requestId: identifierSchema
})

// 协议只表达安全错误语义；展示文案由 Renderer 按界面语言翻译，
// 内部原因不跨越进程边界。NOT_FOUND 用 resource 区分对象。
export const conversationRequestErrorSchema = z.discriminatedUnion('code', [
  z.object({ code: z.literal('NOT_FOUND'), resource: z.enum(['conversation', 'message']) }),
  z.object({ code: z.literal('CONVERSATION_BUSY') }),
  z.object({ code: z.literal('REQUEST_BUSY') }),
  z.object({ code: z.literal('RETRY_NOT_ALLOWED') }),
  z.object({ code: z.literal('REQUEST_NOT_FOUND') }),
  z.object({ code: z.literal('INVALID_INPUT') }),
  z.object({ code: z.literal('UNTRUSTED_SOURCE') }),
  z.object({ code: z.literal('PERSISTENCE_ERROR') }),
  z.object({ code: z.literal('MODEL_ERROR') }),
  z.object({ code: z.literal('MODEL_NOT_CONFIGURED') }),
  z.object({ code: z.literal('CREDENTIAL_DECRYPT_FAILED') }),
  z.object({ code: z.literal('CANCELLED') }),
  z.object({ code: z.literal('UNKNOWN_ERROR') })
])

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
export const runConversationSkillResultSchema = generationResultSchema
export const retryMessageResultSchema = generationResultSchema

export const cancelMessageResultSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('ok') }),
  z.object({ status: z.literal('error'), error: conversationRequestErrorSchema })
])

const generationEventErrorSchema = z.object({
  code: z.enum([
    'MODEL_ERROR',
    'AGENT_UNAVAILABLE',
    'AGENT_PROTOCOL_ERROR',
    'AGENT_LIMIT',
    'AGENT_HOST_ERROR',
    'MODEL_NOT_CONFIGURED',
    'CREDENTIAL_DECRYPT_FAILED',
    'TOOL_CALL_NOT_SUPPORTED',
    'PERSISTENCE_ERROR',
    'UNKNOWN_ERROR'
  ])
})

const eventBaseSchema = z.object({
  requestId: identifierSchema,
  sessionId: identifierSchema
})

export const conversationEventSchema = z.discriminatedUnion('type', [
  eventBaseSchema.extend({ type: z.literal('titleUpdated') }),
  eventBaseSchema.extend({
    type: z.literal('started'),
    userMessage: conversationMessageSchema,
    assistantMessageId: identifierSchema
  }),
  eventBaseSchema.extend({
    type: z.literal('skillPhase'),
    phase: z.enum(['analyzing', 'committing', 'summarizing'])
  }),
  eventBaseSchema.extend({
    type: z.literal('chunk'),
    messageId: identifierSchema,
    delta: z.string()
  }),
  eventBaseSchema.extend({
    // 思考增量：仅请求等待期临时展示，不进入最终消息或会话历史。
    type: z.literal('reasoningChunk'),
    messageId: identifierSchema,
    delta: z.string()
  }),
  eventBaseSchema.extend({
    type: z.literal('completed'),
    message: conversationMessageSchema,
    skillCompletion: z.enum(['complete', 'description_failed', 'description_cancelled']).optional(),
    retryableUserMessageId: identifierSchema.optional()
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
export type RunConversationSkillInput = z.infer<typeof runConversationSkillInputSchema>
export type ConversationSkillArguments = z.infer<typeof conversationSkillArgumentsSchema>
// 技能执行报告的持久化形状：按 skillId 对应各自的批次结构，读取方负责判别。
// ExplorePhraseReport 与 ExploreVocabularyReport 仅存在于各自的 JSON 历史文件
// 与内存分派，不进入数据库报告列。
export type ConversationSkillReport =
  VocabularyBatch | PhraseBatch | SynonymBatch | ExplorePhraseReport | ExploreVocabularyReport
export type RetryMessageInput = z.infer<typeof retryMessageInputSchema>
export type CancelMessageInput = z.infer<typeof cancelMessageInputSchema>
export type SendMessageResult = z.infer<typeof sendMessageResultSchema>
export type RunConversationSkillResult = z.infer<typeof runConversationSkillResultSchema>
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
  runSkill(input: RunConversationSkillInput): Promise<RunConversationSkillResult>
  retry(input: RetryMessageInput): Promise<RetryMessageResult>
  cancel(input: CancelMessageInput): Promise<CancelMessageResult>
  onEvent(listener: (event: ConversationEvent) => void): () => void
}

export interface LingoMateApi {
  conversation: ConversationApi
  preferences: PreferencesApi
  models: ModelsApi
  usage: UsageApi
  vocabulary: VocabularyApi
  phrase: PhraseApi
  synonym: SynonymApi
  vocabularyPractice: VocabularyPracticeApi
  sentencePractice: SentencePracticeApi
  vocabularyMistakes: VocabularyMistakesApi
  // 受限错误上报：preload/renderer 捕获的异常经此进入 Main 的公共日志。
  reportError: ErrorReportApi['reportError']
}
