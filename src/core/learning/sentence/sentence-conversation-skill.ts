import { AgentRuntimeError, type SentenceAgentRuntime } from '../../agent/agent-runtime'
import type {
  ConversationSkill,
  ConversationSkillRunInput,
  ConversationSkillRunResult
} from '../../conversation/conversation-skill'
import type { ConversationSkillReport } from '../../../shared/conversation'
import type { SupportedLocale } from '../../../shared/preferences'
import {
  isSentenceReport,
  sentenceContentSchema,
  sentenceTextSchema,
  type SentenceContent,
  type SentenceReport
} from '../../../shared/sentence'
import type { SentenceRepository } from './sentence-repository'
import type { SentenceTranslator } from './llm-sentence-translator'
import { SentenceLock } from './sentence-lock'

export type SentenceFeedbackFormatter = (
  report: SentenceReport,
  language: SupportedLocale
) => string
export class SentenceConversationSkill implements ConversationSkill {
  readonly skillId = 'sentence' as const
  private readonly lock = new SentenceLock()
  constructor(
    private readonly repository: SentenceRepository,
    private readonly createTranslator: () => SentenceTranslator,
    private readonly runtime: SentenceAgentRuntime,
    private readonly formatFeedback: SentenceFeedbackFormatter
  ) {}
  async run(input: ConversationSkillRunInput): Promise<ConversationSkillRunResult> {
    if (!('text' in input.arguments)) throw new Error('Sentence requires text')
    const sourceText = sentenceTextSchema.parse(input.arguments.text)
    const targetLanguage = input.arguments.wordLanguage
    return this.lock.run(JSON.stringify([targetLanguage, sourceText]), input.signal, async () => {
      const deadline = new AbortController()
      const timer = setTimeout(() => deadline.abort(new AgentRuntimeError('AGENT_LIMIT')), 120_000)
      const bound = { ...input, signal: AbortSignal.any([input.signal, deadline.signal]) }
      try {
        let prepared = false,
          started = false,
          verified = false
        let content: SentenceContent | undefined
        const payload = { sourceText, targetLanguage }
        const inputChars = JSON.stringify(payload).length
        await bound.onPhase('analyzing')
        await this.runtime.runSentence(
          { outputLanguage: bound.explanationLanguage, targetLanguage, signal: bound.signal },
          {
            prepare: () => {
              bound.signal.throwIfAborted()
              if (prepared) throw new AgentRuntimeError('AGENT_PROTOCOL_ERROR')
              prepared = true
              const existing = this.repository.findExisting(sourceText, targetLanguage)
              if (existing)
                content = {
                  sourceText: existing.sourceText,
                  translation: existing.translation,
                  targetLanguage: existing.targetLanguage
                }
              return { existing: !!existing, inputChars }
            },
            model: async ({ systemPrompt }, signal, maxInputChars) => {
              bound.signal.throwIfAborted()
              signal.throwIfAborted()
              if (!prepared || started || content)
                throw new AgentRuntimeError('AGENT_PROTOCOL_ERROR')
              if (systemPrompt.length > 4096 || inputChars + systemPrompt.length > maxInputChars)
                throw new AgentRuntimeError('AGENT_LIMIT')
              started = true
              const translation = await this.createTranslator().translate({
                ...payload,
                systemPrompt,
                signal
              })
              bound.signal.throwIfAborted()
              signal.throwIfAborted()
              content = sentenceContentSchema.parse({ ...payload, translation })
              return { completed: true }
            },
            verifyCompletion: (result) => {
              bound.signal.throwIfAborted()
              if (!prepared || !content || verified || !result.completed)
                throw new AgentRuntimeError('AGENT_PROTOCOL_ERROR')
              verified = true
            }
          }
        )
        bound.signal.throwIfAborted()
        if (!verified || !content) throw new AgentRuntimeError('AGENT_PROTOCOL_ERROR')
        await bound.onPhase('committing')
        bound.signal.throwIfAborted()
        // Synchronous commit follows the final cancellation check without an await.
        const report = this.repository.commit(
          bound.executionId,
          bound.requestId,
          bound.explanationLanguage,
          content
        )
        await bound.onPhase('summarizing')
        return { outcome: 'completed', report }
      } finally {
        clearTimeout(timer)
      }
    })
  }
  feedback(report: ConversationSkillReport, language: SupportedLocale): string {
    if (!isSentenceReport(report)) throw new Error('Report does not match sentence')
    return this.formatFeedback(report, language)
  }
}
