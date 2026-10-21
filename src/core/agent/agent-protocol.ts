import { z } from 'zod'

export const AGENT_PROTOCOL_VERSION = 3
export const MAX_AGENT_SYSTEM_PROMPT_CHARS = 4096
export const MAX_AGENT_FRAME_BYTES = 262_144
export const AGENT_OPERATIONS = [
  'model.reply',
  'model.decide',
  'learning.lookup',
  'vocabulary.prepare',
  'model.vocabulary'
] as const
const identity = z.string().min(1).max(128)
const text = z.string().max(65_536)
export const agentOperationSchema = z.enum(AGENT_OPERATIONS)
export const agentMessageSchema = z.strictObject({
  role: z.enum(['user', 'assistant']),
  content: text
})
export const agentBudgetSchema = z.strictObject({
  timeoutMs: z.number().int().min(1).max(180_000),
  maxModelCalls: z.number().int().min(1).max(20),
  maxToolCalls: z.number().int().min(0).max(8),
  maxSteps: z.number().int().min(1).max(32),
  maxInputChars: z.number().int().min(4096).max(65_536),
  maxOutputChars: z.number().int().min(1).max(65_536)
})
export const agentSnapshotSchema = z.strictObject({
  task: z.enum(['conversation', 'tool-loop', 'vocabulary']),
  messages: z.array(agentMessageSchema).min(1).max(100),
  outputLanguage: z.string().min(2).max(35),
  targetLanguage: z.string().min(2).max(35),
  allowedOperations: z.array(agentOperationSchema).max(5),
  budget: agentBudgetSchema
})
export const agentDecisionSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('final'), text }),
  z.strictObject({
    kind: z.literal('tool'),
    name: z.literal('learning.lookup'),
    query: z.string().min(1).max(256)
  })
])
const vocabularyIndex = z.number().int().min(0).max(19)
export const vocabularyPreparedItemSchema = z.discriminatedUnion('status', [
  z.strictObject({
    inputIndex: vocabularyIndex,
    term: z.string().min(1).max(4000),
    status: z.literal('pending')
  }),
  z.strictObject({
    inputIndex: vocabularyIndex,
    term: z.string().min(1).max(4000),
    status: z.literal('existing')
  }),
  z.strictObject({
    inputIndex: vocabularyIndex,
    term: z.string().min(1).max(4000),
    status: z.literal('duplicate'),
    sourceInputIndex: vocabularyIndex
  })
])
export const vocabularyPreparedSchema = z.strictObject({
  items: z.array(vocabularyPreparedItemSchema).min(1).max(20)
})
export const vocabularyAnalysisReceiptSchema = z.discriminatedUnion('status', [
  z.strictObject({ inputIndex: vocabularyIndex, status: z.literal('staged') }),
  z.strictObject({
    inputIndex: vocabularyIndex,
    status: z.literal('failed'),
    code: z.enum([
      'MODEL_NOT_CONFIGURED',
      'CREDENTIAL_DECRYPT_FAILED',
      'MODEL_ERROR',
      'INVALID_ANALYSIS',
      'UNRECOGNIZED',
      'TIMEOUT'
    ])
  })
])
export const vocabularyCompletionSchema = z.strictObject({
  completedIndices: z.array(vocabularyIndex).max(20)
})
export type VocabularyPrepared = z.infer<typeof vocabularyPreparedSchema>
export type VocabularyAnalysisReceipt = z.infer<typeof vocabularyAnalysisReceiptSchema>
export type VocabularyCompletion = z.infer<typeof vocabularyCompletionSchema>
export const agentHostResultSchema = z.union([
  z.strictObject({ text }),
  agentDecisionSchema,
  vocabularyPreparedSchema,
  vocabularyAnalysisReceiptSchema,
  z.strictObject({ entries: z.array(z.string().max(1024)).max(10) })
])
// Zod/JSON Schema count code points; the wire budget is measured in UTF-16 units.
const systemPromptSchema = z
  .string()
  .min(1)
  .max(MAX_AGENT_SYSTEM_PROMPT_CHARS)
  .refine((value) => value.length <= MAX_AGENT_SYSTEM_PROMPT_CHARS)
export const agentCallArgsSchema = z.strictObject({
  systemPrompt: systemPromptSchema.optional(),
  inputIndex: vocabularyIndex.optional(),
  query: z.string().min(1).max(256).optional(),
  results: z
    .array(z.strictObject({ entries: z.array(z.string().max(1024)).max(10) }))
    .max(8)
    .optional()
})
export const agentReplyArgsSchema = z.strictObject({
  systemPrompt: systemPromptSchema
})
export const vocabularyModelArgsSchema = z.strictObject({
  inputIndex: vocabularyIndex,
  systemPrompt: systemPromptSchema
})
export const agentErrorCodeSchema = z.enum([
  'AGENT_UNAVAILABLE',
  'AGENT_PROTOCOL_ERROR',
  'AGENT_LIMIT',
  'AGENT_HOST_ERROR'
])
const base = { v: z.literal(AGENT_PROTOCOL_VERSION), instanceId: identity }
const run = { ...base, runId: identity }
const call = { ...run, callId: identity }
const event = z.strictObject({ type: z.enum(['text', 'reasoning']), delta: text })
export const agentFrameSchema = z.discriminatedUnion('type', [
  z.strictObject({ ...base, type: z.literal('hello') }),
  z.strictObject({
    ...base,
    type: z.literal('ready'),
    capabilities: z.array(z.enum(['conversation', 'tool-loop', 'vocabulary'])).max(3)
  }),
  z.strictObject({ ...run, type: z.literal('run'), snapshot: agentSnapshotSchema }),
  z.discriminatedUnion('operation', [
    z.strictObject({
      ...call,
      type: z.literal('host_call'),
      operation: z.literal('vocabulary.prepare'),
      args: z.strictObject({})
    }),
    z.strictObject({
      ...call,
      type: z.literal('host_call'),
      operation: z.literal('model.vocabulary'),
      args: vocabularyModelArgsSchema
    }),
    z.strictObject({
      ...call,
      type: z.literal('host_call'),
      operation: z.literal('model.reply'),
      args: agentReplyArgsSchema
    }),
    z.strictObject({
      ...call,
      type: z.literal('host_call'),
      operation: z.literal('model.decide'),
      args: agentCallArgsSchema.omit({ systemPrompt: true, query: true, inputIndex: true })
    }),
    z.strictObject({
      ...call,
      type: z.literal('host_call'),
      operation: z.literal('learning.lookup'),
      args: z.strictObject({ query: z.string().min(1).max(256) })
    })
  ]),
  z.strictObject({ ...call, type: z.literal('host_result'), result: agentHostResultSchema }),
  z.strictObject({ ...call, type: z.literal('host_error'), code: agentErrorCodeSchema }),
  z.strictObject({
    ...call,
    type: z.literal('host_chunk'),
    seq: z.number().int().positive(),
    event
  }),
  z.strictObject({ ...run, type: z.literal('event'), seq: z.number().int().positive(), event }),
  z.strictObject({ ...run, type: z.literal('cancel') }),
  z.strictObject({ ...run, type: z.literal('result'), text }),
  z.strictObject({
    ...run,
    type: z.literal('vocabulary_result'),
    result: vocabularyCompletionSchema
  }),
  z.strictObject({ ...run, type: z.literal('error'), code: agentErrorCodeSchema }),
  z.strictObject({ ...run, type: z.literal('cancelled') }),
  z.strictObject({ ...base, type: z.literal('shutdown') }),
  z.strictObject({ ...base, type: z.literal('shutdown_ack') })
])
export type AgentFrame = z.infer<typeof agentFrameSchema>
export type AgentSnapshot = z.infer<typeof agentSnapshotSchema>
export type AgentBudget = z.infer<typeof agentBudgetSchema>
export type AgentOperation = z.infer<typeof agentOperationSchema>
export type AgentDecision = z.infer<typeof agentDecisionSchema>
export type AgentHostResult = z.infer<typeof agentHostResultSchema>
export type AgentCallArgs = z.infer<typeof agentCallArgsSchema>
export type AgentErrorCode = z.infer<typeof agentErrorCodeSchema>
