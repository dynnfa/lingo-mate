import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions'
import { z } from 'zod'
import { VOCABULARY_PRACTICE_SUMMARY_MAX_LENGTH } from '../../shared/vocabulary-practice'
import { VocabularyPracticeError } from '../learning/vocabulary-practice/parse-vocabulary-practice-input'
import type {
  PracticeReviewOutcome,
  VocabularyPracticeReviewer
} from '../learning/vocabulary-practice/vocabulary-practice-reviewer'
import { vocabularyPracticeReviewSystemMessage } from '../prompt/vocabulary-practice-review'
import {
  VocabularyPracticeToolExecutor,
  vocabularyPracticeTools
} from '../tools/vocabulary-practice-tools'
import type { RuntimeModelConfig } from './model-config'
import { classifyModelRequestError, type CreateLlmClient } from './llm-client'
import { isUnsupportedToolCall } from './tool-protocol'
import { toolRequestParams } from './tool-request-policy'

// 最终反馈是正常文本响应里的 JSON，不是工具结果：只有它和累计标记
// 一致时审查才算完成，空响应、非法 JSON 或矛盾反馈都按失败处理。
const finalFeedbackSchema = z.strictObject({
  verdict: z.enum(['all_correct', 'has_errors']),
  summary: z.string().trim().min(1).max(VOCABULARY_PRACTICE_SUMMARY_MAX_LENGTH)
})

// 工具调用可附带说明文本；只有正常结束且无工具调用时才解析最终反馈。
const responseSchema = z.object({
  choices: z
    .array(
      z.object({
        finish_reason: z.string().nullable(),
        message: z.object({
          content: z.string().nullable().optional(),
          refusal: z.string().nullable().optional(),
          reasoning_content: z.string().optional(),
          tool_calls: z
            .array(
              z.object({
                id: z.string().min(1),
                type: z.literal('function'),
                function: z.object({ name: z.string(), arguments: z.string() })
              })
            )
            .optional()
        })
      })
    )
    .min(1)
})

const MAX_CORRECTION_ROUNDS = 2

export class LlmVocabularyPracticeReviewer implements VocabularyPracticeReviewer {
  constructor(
    private readonly config: RuntimeModelConfig,
    private readonly timeoutMs: number,
    private readonly createClient: CreateLlmClient,
    private readonly maxRounds = 8
  ) {}

  async review(
    input: Parameters<VocabularyPracticeReviewer['review']>[0]
  ): Promise<PracticeReviewOutcome> {
    if (!this.config.configured) throw new VocabularyPracticeError('MODEL_NOT_CONFIGURED')
    const client = this.createClient(this.config)
    const executor = new VocabularyPracticeToolExecutor(
      new Set(input.entries.map((entry) => entry.entryId)),
      input.signal
    )
    const messages: ChatCompletionMessageParam[] = [
      {
        role: 'system',
        content: vocabularyPracticeReviewSystemMessage(input.explanationLanguage)
      },
      {
        role: 'user',
        content: JSON.stringify({ entries: input.entries })
      }
    ]
    const seenCallIds = new Set<string>()
    let corrections = 0
    try {
      for (let round = 0; round < this.maxRounds; round++) {
        if (input.signal.aborted) throw new VocabularyPracticeError('CANCELLED')
        const response = await client.complete(
          {
            model: this.config.modelId,
            messages,
            tools: vocabularyPracticeTools(),
            ...toolRequestParams('multi-turn-tool-loop', this.config)
          },
          // 审查复用词汇域的用量口径，不新增数据库 operation 枚举。
          { operation: 'vocabulary_analysis', signal: input.signal, timeoutMs: this.timeoutMs }
        )
        if (input.signal.aborted) throw new VocabularyPracticeError('CANCELLED')
        const parsed = responseSchema.safeParse(response)
        if (!parsed.success)
          throw new VocabularyPracticeError('INVALID_ANALYSIS', { cause: parsed.error })
        const choice = parsed.data.choices[0]
        const message = choice.message
        const calls = message.tool_calls ?? []
        if (
          message.refusal ||
          choice.finish_reason !== (calls.length > 0 ? 'tool_calls' : 'stop')
        ) {
          throw new VocabularyPracticeError('INVALID_ANALYSIS')
        }
        if (calls.length > 0) {
          // Preserve call ids and provider reasoning fields for multi-turn tool protocols.
          messages.push({ ...message, role: 'assistant' })
          for (const call of calls) {
            if (seenCallIds.has(call.id)) throw new VocabularyPracticeError('INVALID_ANALYSIS')
            seenCallIds.add(call.id)
            const outcome = this.executeCall(executor, call.function.name, call.function.arguments)
            messages.push({
              role: 'tool',
              tool_call_id: call.id,
              content: JSON.stringify(outcome)
            })
          }
          continue
        }
        if (typeof message.content !== 'string' || !message.content.trim())
          throw new VocabularyPracticeError('INVALID_ANALYSIS')
        const feedback = this.parseFinalFeedback(message.content)
        if (feedback.verdict === 'all_correct') {
          // 文字与标记矛盾属于无效审查，不要求模型补救。
          if (executor.marked.length > 0) throw new VocabularyPracticeError('INVALID_ANALYSIS')
          return { verdict: feedback.verdict, summary: feedback.summary, marks: [] }
        }
        if (executor.marked.length > 0) {
          return { verdict: feedback.verdict, summary: feedback.summary, marks: executor.marked }
        }
        // 反馈指出错误但没有标记：要求模型补齐工具调用，有限重试后失败。
        if (corrections >= MAX_CORRECTION_ROUNDS)
          throw new VocabularyPracticeError('INVALID_ANALYSIS')
        corrections++
        messages.push({ role: 'user', content: this.marksRequiredMessage() })
      }
      throw new VocabularyPracticeError('ROUND_LIMIT')
    } catch (cause) {
      if (cause instanceof VocabularyPracticeError) throw cause
      if (isUnsupportedToolCall(cause))
        throw new VocabularyPracticeError('TOOL_CALL_NOT_SUPPORTED', { cause })
      throw new VocabularyPracticeError(
        classifyModelRequestError(cause) === 'TIMEOUT' ? 'TIMEOUT' : 'MODEL_ERROR',
        { cause }
      )
    }
  }

  private executeCall(
    executor: VocabularyPracticeToolExecutor,
    name: string,
    rawArguments: string
  ): { status: 'marked'; markedCount: number } | { error: string } {
    let args: unknown
    try {
      args = JSON.parse(rawArguments)
    } catch {
      return { error: 'INVALID_ARGUMENTS' }
    }
    const outcome = executor.execute(name, args)
    if (!outcome.ok) return { error: outcome.error }
    return outcome.result
  }

  private parseFinalFeedback(content: string): z.infer<typeof finalFeedbackSchema> {
    let feedback: unknown
    try {
      feedback = JSON.parse(content.trim())
    } catch (cause) {
      throw new VocabularyPracticeError('INVALID_ANALYSIS', { cause })
    }
    const parsed = finalFeedbackSchema.safeParse(feedback)
    if (!parsed.success) throw new VocabularyPracticeError('INVALID_ANALYSIS')
    return parsed.data
  }

  private marksRequiredMessage(): string {
    return 'Your final feedback reports errors, but no answer was marked with mark_text_red. Call mark_text_red for every wrong answer first, then send the final JSON feedback again.'
  }
}
