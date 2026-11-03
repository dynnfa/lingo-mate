import { z } from 'zod'

export const AGENT_PROTOCOL_VERSION = 12
export const MAX_AGENT_SYSTEM_PROMPT_CHARS = 4096
export const MAX_AGENT_FRAME_BYTES = 262_144
export const AGENT_OPERATIONS = [
  'sentence.prepare',
  'model.sentence',
  'tts.synthesize',
  'vocabulary-practice.prepare',
  'model.vocabulary-practice-review',
  'vocabulary-practice.apply',
  'vocabulary-practice.correct',
  'vocabulary-practice.finish',
  'sentence-practice.prepare',
  'model.sentence-practice-hints',
  'model.sentence-practice-review',
  'model.reply',
  'model.title',
  'model.decide',
  'learning.lookup',
  'vocabulary.prepare',
  'model.vocabulary',
  'phrase.prepare',
  'model.phrase',
  'synonym.prepare',
  'model.synonym',
  'synonym.apply',
  'synonym.finish',
  'explore-phrase.prepare',
  'model.explore-phrase',
  'explore-vocabulary.prepare',
  'model.explore-vocabulary'
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
  maxModelCalls: z.number().int().min(1).max(1040),
  maxToolCalls: z.number().int().min(0).max(1061),
  maxSteps: z.number().int().min(1).max(2200),
  maxInputChars: z.number().int().min(4096).max(65_536),
  maxOutputChars: z.number().int().min(1).max(524_288)
})
const snapshotFields = {
  messages: z.array(agentMessageSchema).min(1).max(100),
  outputLanguage: z.string().min(2).max(35),
  targetLanguage: z.string().min(2).max(35),
  allowedOperations: z.array(agentOperationSchema).max(11)
}
export const sentencePracticeTaskSchema = z.enum([
  'sentence-practice-hints',
  'sentence-practice-review'
])
export type SentencePracticeTask = z.infer<typeof sentencePracticeTaskSchema>
export const agentSnapshotSchema = z.discriminatedUnion('task', [
  z.strictObject({
    ...snapshotFields,
    task: z.literal('tts'),
    allowedOperations: z.tuple([z.literal('tts.synthesize')]),
    budget: z.strictObject({
      timeoutMs: z.literal(180_000),
      maxModelCalls: z.literal(0),
      maxToolCalls: z.literal(1),
      maxSteps: z.literal(1),
      maxInputChars: z.literal(4096),
      maxOutputChars: z.literal(1024)
    })
  }),
  z.strictObject({
    ...snapshotFields,
    task: z.literal('vocabulary-practice-review'),
    budget: z.strictObject({
      timeoutMs: z.literal(120_000),
      maxModelCalls: z.literal(8),
      maxToolCalls: z.literal(10),
      maxSteps: z.literal(18),
      maxInputChars: z.literal(65_536),
      maxOutputChars: z.literal(4096)
    })
  }),
  z.strictObject({
    ...snapshotFields,
    task: z.literal('sentence'),
    allowedOperations: z.tuple([z.literal('sentence.prepare'), z.literal('model.sentence')]),
    budget: z.strictObject({
      timeoutMs: z.literal(120_000),
      maxModelCalls: z.literal(1),
      maxToolCalls: z.literal(1),
      maxSteps: z.literal(2),
      maxInputChars: z.literal(65_536),
      maxOutputChars: z.literal(1024)
    })
  }),
  z.strictObject({
    ...snapshotFields,
    task: sentencePracticeTaskSchema,
    budget: z.strictObject({
      timeoutMs: z.literal(120_000),
      maxModelCalls: z.literal(1),
      maxToolCalls: z.literal(1),
      maxSteps: z.literal(2),
      maxInputChars: z.literal(65_536),
      maxOutputChars: z.literal(1024)
    })
  }),
  z.strictObject({
    ...snapshotFields,
    task: z.literal('conversation-title'),
    messages: z.array(z.strictObject({ role: z.literal('user'), content: text })).length(1),
    allowedOperations: z.tuple([z.literal('model.title')]),
    budget: z.strictObject({
      timeoutMs: z.literal(120_000),
      maxModelCalls: z.literal(1),
      maxToolCalls: z.literal(0),
      maxSteps: z.literal(1),
      maxInputChars: z.literal(32_768),
      maxOutputChars: z.literal(80)
    })
  }),
  z.strictObject({
    ...snapshotFields,
    task: z.enum(['conversation', 'tool-loop', 'vocabulary', 'phrase']),
    budget: agentBudgetSchema.extend({
      maxModelCalls: z.number().int().min(1).max(20),
      maxToolCalls: z.number().int().min(0).max(8),
      maxSteps: z.number().int().min(1).max(32),
      maxOutputChars: z.number().int().min(1).max(65_536)
    })
  }),
  z.strictObject({ ...snapshotFields, task: z.literal('synonym'), budget: agentBudgetSchema }),
  z.strictObject({
    ...snapshotFields,
    task: z.enum(['explore-phrase', 'explore-vocabulary']),
    budget: agentBudgetSchema.extend({
      maxModelCalls: z.number().int().min(1).max(3),
      maxToolCalls: z.number().int().min(0).max(1),
      maxSteps: z.number().int().min(1).max(8),
      maxOutputChars: z.number().int().min(1).max(32_768)
    })
  })
])
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
const phraseIndex = z.number().int().min(0).max(19)
export const phrasePreparedItemSchema = z.discriminatedUnion('status', [
  z.strictObject({
    inputIndex: phraseIndex,
    phrase: z.string().min(1).max(200),
    status: z.literal('pending')
  }),
  z.strictObject({
    inputIndex: phraseIndex,
    phrase: z.string().min(1).max(200),
    status: z.literal('existing')
  }),
  z.strictObject({
    inputIndex: phraseIndex,
    phrase: z.string().min(1).max(200),
    status: z.literal('duplicate'),
    sourceInputIndex: phraseIndex
  })
])
export const phrasePreparedSchema = z.strictObject({
  items: z.array(phrasePreparedItemSchema).min(1).max(20)
})
export const phraseAnalysisReceiptSchema = z.discriminatedUnion('status', [
  z.strictObject({ inputIndex: phraseIndex, status: z.literal('staged') }),
  z.strictObject({
    inputIndex: phraseIndex,
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
export const phraseCompletionSchema = z.strictObject({
  completedIndices: z.array(phraseIndex).max(20)
})
export type PhrasePrepared = z.infer<typeof phrasePreparedSchema>
export type PhraseAnalysisReceipt = z.infer<typeof phraseAnalysisReceiptSchema>
export type PhraseCompletion = z.infer<typeof phraseCompletionSchema>
const synonymIndex = z.number().int().min(0).max(19)
const synonymRound = z.number().int().min(1).max(52)
export const synonymPreparedSchema = z.strictObject({
  items: z
    .array(z.strictObject({ inputIndex: synonymIndex, status: z.enum(['pending', 'resolved']) }))
    .min(1)
    .max(20)
})
export const synonymTurnSchema = z.strictObject({
  inputIndex: synonymIndex,
  round: synonymRound,
  kind: z.enum(['tool', 'parallel', 'failed']),
  inputChars: z.number().int().min(0).max(65_536)
})
export const synonymAppliedSchema = z.strictObject({
  inputIndex: synonymIndex,
  round: synonymRound,
  kind: z.enum(['continue', 'terminal', 'failed'])
})
export const synonymFinishedSchema = z.strictObject({ inputIndex: synonymIndex, stop: z.boolean() })
export const synonymCompletionSchema = z.strictObject({
  completedIndices: z.array(synonymIndex).max(20)
})
export type SynonymPrepared = z.infer<typeof synonymPreparedSchema>
export type SynonymTurn = z.infer<typeof synonymTurnSchema>
export type SynonymApplied = z.infer<typeof synonymAppliedSchema>
export type SynonymFinished = z.infer<typeof synonymFinishedSchema>
export type SynonymCompletion = z.infer<typeof synonymCompletionSchema>
const explorePhraseAttempt = z.number().int().min(1).max(3)
export const explorePhrasePreparedSchema = z.strictObject({
  acceptedCount: z.literal(0),
  inputChars: z.number().int().min(0).max(65_536)
})
export const explorePhraseReceiptSchema = z.strictObject({
  attempt: explorePhraseAttempt,
  acceptedCount: z.number().int().min(0).max(10),
  inputChars: z.number().int().min(0).max(65_536)
})
export const explorePhraseCompletionSchema = z.strictObject({
  attempts: explorePhraseAttempt,
  acceptedCount: z.number().int().min(0).max(10)
})
export type ExplorePhrasePrepared = z.infer<typeof explorePhrasePreparedSchema>
export type ExplorePhraseReceipt = z.infer<typeof explorePhraseReceiptSchema>
export type ExplorePhraseCompletion = z.infer<typeof explorePhraseCompletionSchema>
const exploreVocabularyAttempt = z.number().int().min(1).max(3)
export const exploreVocabularyPreparedSchema = z.strictObject({
  acceptedCount: z.literal(0),
  inputChars: z.number().int().min(0).max(65_536)
})
export const exploreVocabularyReceiptSchema = z.strictObject({
  attempt: exploreVocabularyAttempt,
  acceptedCount: z.number().int().min(0).max(10),
  inputChars: z.number().int().min(0).max(65_536)
})
export const exploreVocabularyCompletionSchema = z.strictObject({
  attempts: exploreVocabularyAttempt,
  acceptedCount: z.number().int().min(0).max(10)
})
export type ExploreVocabularyPrepared = z.infer<typeof exploreVocabularyPreparedSchema>
export type ExploreVocabularyReceipt = z.infer<typeof exploreVocabularyReceiptSchema>
export type ExploreVocabularyCompletion = z.infer<typeof exploreVocabularyCompletionSchema>
export const sentencePracticePreparedSchema = z.strictObject({
  inputChars: z.number().int().min(0).max(65_536)
})
export const ttsCompletionSchema = z.strictObject({ completed: z.literal(true) })
export type TtsCompletion = z.infer<typeof ttsCompletionSchema>

export const sentencePracticeCompletionSchema = z.strictObject({ completed: z.literal(true) })
export type SentencePracticePrepared = z.infer<typeof sentencePracticePreparedSchema>
export type SentencePracticeCompletion = z.infer<typeof sentencePracticeCompletionSchema>
const practiceRound = z.number().int().min(1).max(8)
export const vocabularyPracticePreparedSchema = z.strictObject({
  inputChars: z.number().int().min(0).max(65_536)
})
export const vocabularyPracticeTurnSchema = z.strictObject({
  round: practiceRound,
  kind: z.enum(['tools', 'complete', 'missing_marks']),
  inputChars: z.number().int().min(0).max(65_536)
})
export const vocabularyPracticeAppliedSchema = z.strictObject({
  round: practiceRound,
  applied: z.literal(true)
})
export const vocabularyPracticeCompletionSchema = z.strictObject({
  completed: z.literal(true),
  rounds: practiceRound
})
export type VocabularyPracticeTurn = z.infer<typeof vocabularyPracticeTurnSchema>
export type VocabularyPracticeCompletion = z.infer<typeof vocabularyPracticeCompletionSchema>
export const sentencePreparedSchema = z.strictObject({
  existing: z.boolean(),
  inputChars: z.number().int().min(0).max(65_536)
})
export type SentencePrepared = z.infer<typeof sentencePreparedSchema>
export const agentHostResultSchema = z.union([
  sentencePreparedSchema,
  ttsCompletionSchema,
  vocabularyPracticeTurnSchema,
  vocabularyPracticeAppliedSchema,
  vocabularyPracticeCompletionSchema,
  sentencePracticePreparedSchema,
  sentencePracticeCompletionSchema,
  z.strictObject({ text }),
  agentDecisionSchema,
  vocabularyPreparedSchema,
  vocabularyAnalysisReceiptSchema,
  phrasePreparedSchema,
  phraseAnalysisReceiptSchema,
  synonymPreparedSchema,
  synonymTurnSchema,
  synonymAppliedSchema,
  synonymFinishedSchema,
  explorePhrasePreparedSchema,
  explorePhraseReceiptSchema,
  exploreVocabularyPreparedSchema,
  exploreVocabularyReceiptSchema,
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
  instruction: systemPromptSchema.optional(),
  inputIndex: vocabularyIndex.optional(),
  round: synonymRound.optional(),
  attempt: explorePhraseAttempt.optional(),
  action: z.enum(['execute', 'reject_parallel']).optional(),
  reason: z.enum(['terminal', 'failed', 'round_limit', 'correction_limit']).optional(),
  query: z.string().min(1).max(256).optional(),
  results: z
    .array(z.strictObject({ entries: z.array(z.string().max(1024)).max(10) }))
    .max(8)
    .optional()
})
export const vocabularyPracticeModelArgsSchema = z.strictObject({
  round: practiceRound,
  systemPrompt: systemPromptSchema
})
export const vocabularyPracticeApplyArgsSchema = z.strictObject({ round: practiceRound })
export const vocabularyPracticeCorrectArgsSchema = z.strictObject({
  round: practiceRound,
  instruction: systemPromptSchema
})
export const vocabularyPracticeFinishArgsSchema = z.strictObject({
  round: practiceRound,
  reason: z.enum(['terminal', 'round_limit', 'correction_limit'])
})
export type VocabularyPracticeModelArgs = z.infer<typeof vocabularyPracticeModelArgsSchema>
export type VocabularyPracticeApplyArgs = z.infer<typeof vocabularyPracticeApplyArgsSchema>
export type VocabularyPracticeCorrectArgs = z.infer<typeof vocabularyPracticeCorrectArgsSchema>
export type VocabularyPracticeFinishArgs = z.infer<typeof vocabularyPracticeFinishArgsSchema>
export const agentReplyArgsSchema = z.strictObject({
  systemPrompt: systemPromptSchema
})
export const vocabularyModelArgsSchema = z.strictObject({
  inputIndex: vocabularyIndex,
  systemPrompt: systemPromptSchema
})
export const phraseModelArgsSchema = z.strictObject({
  inputIndex: phraseIndex,
  systemPrompt: systemPromptSchema
})
export const explorePhraseModelArgsSchema = z.strictObject({
  attempt: explorePhraseAttempt,
  systemPrompt: systemPromptSchema
})
export type ExplorePhraseModelArgs = z.infer<typeof explorePhraseModelArgsSchema>
export const exploreVocabularyModelArgsSchema = z.strictObject({
  attempt: exploreVocabularyAttempt,
  systemPrompt: systemPromptSchema
})
export type ExploreVocabularyModelArgs = z.infer<typeof exploreVocabularyModelArgsSchema>
export const synonymModelArgsSchema = z.strictObject({
  inputIndex: synonymIndex,
  round: synonymRound,
  systemPrompt: systemPromptSchema
})
export const synonymApplyArgsSchema = z.strictObject({
  inputIndex: synonymIndex,
  round: synonymRound,
  action: z.enum(['execute', 'reject_parallel'])
})
export const synonymFinishArgsSchema = z.strictObject({
  inputIndex: synonymIndex,
  round: synonymRound,
  reason: z.enum(['terminal', 'failed', 'round_limit'])
})
export type SynonymModelArgs = z.infer<typeof synonymModelArgsSchema>
export type SynonymApplyArgs = z.infer<typeof synonymApplyArgsSchema>
export type SynonymFinishArgs = z.infer<typeof synonymFinishArgsSchema>
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
    capabilities: z
      .array(
        z.enum([
          'sentence',
          'tts',
          'vocabulary-practice-review',
          'sentence-practice-hints',
          'sentence-practice-review',
          'conversation',
          'conversation-title',
          'tool-loop',
          'vocabulary',
          'phrase',
          'synonym',
          'explore-phrase',
          'explore-vocabulary'
        ])
      )
      .max(13)
  }),
  z.strictObject({ ...run, type: z.literal('run'), snapshot: agentSnapshotSchema }),
  z.discriminatedUnion('operation', [
    z.strictObject({
      ...call,
      type: z.literal('host_call'),
      operation: z.literal('sentence.prepare'),
      args: z.strictObject({})
    }),
    z.strictObject({
      ...call,
      type: z.literal('host_call'),
      operation: z.literal('model.sentence'),
      args: agentReplyArgsSchema
    }),
    z.strictObject({
      ...call,
      type: z.literal('host_call'),
      operation: z.literal('tts.synthesize'),
      args: z.strictObject({})
    }),
    z.strictObject({
      ...call,
      type: z.literal('host_call'),
      operation: z.literal('vocabulary-practice.prepare'),
      args: z.strictObject({})
    }),
    z.strictObject({
      ...call,
      type: z.literal('host_call'),
      operation: z.literal('model.vocabulary-practice-review'),
      args: vocabularyPracticeModelArgsSchema
    }),
    z.strictObject({
      ...call,
      type: z.literal('host_call'),
      operation: z.literal('vocabulary-practice.apply'),
      args: vocabularyPracticeApplyArgsSchema
    }),
    z.strictObject({
      ...call,
      type: z.literal('host_call'),
      operation: z.literal('vocabulary-practice.correct'),
      args: vocabularyPracticeCorrectArgsSchema
    }),
    z.strictObject({
      ...call,
      type: z.literal('host_call'),
      operation: z.literal('vocabulary-practice.finish'),
      args: vocabularyPracticeFinishArgsSchema
    }),
    z.strictObject({
      ...call,
      type: z.literal('host_call'),
      operation: z.literal('sentence-practice.prepare'),
      args: z.strictObject({})
    }),
    z.strictObject({
      ...call,
      type: z.literal('host_call'),
      operation: z.literal('model.sentence-practice-hints'),
      args: agentReplyArgsSchema
    }),
    z.strictObject({
      ...call,
      type: z.literal('host_call'),
      operation: z.literal('model.sentence-practice-review'),
      args: agentReplyArgsSchema
    }),
    z.strictObject({
      ...call,
      type: z.literal('host_call'),
      operation: z.literal('model.title'),
      args: agentReplyArgsSchema
    }),
    z.strictObject({
      ...call,
      type: z.literal('host_call'),
      operation: z.literal('explore-phrase.prepare'),
      args: z.strictObject({})
    }),
    z.strictObject({
      ...call,
      type: z.literal('host_call'),
      operation: z.literal('model.explore-phrase'),
      args: explorePhraseModelArgsSchema
    }),
    z.strictObject({
      ...call,
      type: z.literal('host_call'),
      operation: z.literal('explore-vocabulary.prepare'),
      args: z.strictObject({})
    }),
    z.strictObject({
      ...call,
      type: z.literal('host_call'),
      operation: z.literal('model.explore-vocabulary'),
      args: exploreVocabularyModelArgsSchema
    }),
    z.strictObject({
      ...call,
      type: z.literal('host_call'),
      operation: z.literal('synonym.prepare'),
      args: z.strictObject({})
    }),
    z.strictObject({
      ...call,
      type: z.literal('host_call'),
      operation: z.literal('model.synonym'),
      args: synonymModelArgsSchema
    }),
    z.strictObject({
      ...call,
      type: z.literal('host_call'),
      operation: z.literal('synonym.apply'),
      args: synonymApplyArgsSchema
    }),
    z.strictObject({
      ...call,
      type: z.literal('host_call'),
      operation: z.literal('synonym.finish'),
      args: synonymFinishArgsSchema
    }),
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
      operation: z.literal('phrase.prepare'),
      args: z.strictObject({})
    }),
    z.strictObject({
      ...call,
      type: z.literal('host_call'),
      operation: z.literal('model.phrase'),
      args: phraseModelArgsSchema
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
      args: agentCallArgsSchema.pick({ results: true })
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
  z.strictObject({
    ...run,
    type: z.literal('phrase_result'),
    result: phraseCompletionSchema
  }),
  z.strictObject({ ...run, type: z.literal('error'), code: agentErrorCodeSchema }),
  z.strictObject({ ...run, type: z.literal('synonym_result'), result: synonymCompletionSchema }),
  z.strictObject({
    ...run,
    type: z.literal('explore_phrase_result'),
    result: explorePhraseCompletionSchema
  }),
  z.strictObject({
    ...run,
    type: z.literal('explore_vocabulary_result'),
    result: exploreVocabularyCompletionSchema
  }),
  z.strictObject({
    ...run,
    type: z.literal('sentence_practice_result'),
    result: sentencePracticeCompletionSchema
  }),
  z.strictObject({
    ...run,
    type: z.literal('vocabulary_practice_result'),
    result: vocabularyPracticeCompletionSchema
  }),
  z.strictObject({
    ...run,
    type: z.literal('sentence_result'),
    result: sentencePracticeCompletionSchema
  }),
  z.strictObject({ ...run, type: z.literal('tts_result'), result: ttsCompletionSchema }),
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
