import { ZodError } from 'zod'
import { VocabularyError } from './parse-vocabulary-input'
import {
  validateInsertArguments,
  VOCABULARY_INSERT_TOOL_NAME,
  VOCABULARY_UNRECOGNIZED_TOOL_NAME,
  vocabularyInsertTools,
  unrecognizedToolArgumentsSchema
} from './vocabulary-insert'
import type {
  AnalyzeVocabularyInput,
  VocabularyModelAnalyzer,
  VocabularyAnalysisResult
} from './vocabulary-analyzer'
import { abortableOperation } from './abortable-operation'
import { VOCABULARY_PROMPT_VERSION } from './vocabulary-analyzer'
import type { RuntimeModelConfig } from '../../llm/model-config'
import { classifyModelRequestError, type CreateLlmClient } from '../../llm/llm-client'
import { isUnsupportedToolCall, parseSingleToolCallResponse } from '../../llm/tool-protocol'
import { toolRequestParams } from '../../llm/tool-request-policy'

export interface VocabularyAnalysisFailure {
  term: string
  modelId: string
  promptVersion: string
  code: string
  reason?: string
  stage: 'request' | 'protocol' | 'tool-name' | 'arguments'
  response: unknown
  issues: Array<{ path: PropertyKey[]; code: string; message: string }>
}

export class LlmVocabularyAnalyzer implements VocabularyModelAnalyzer {
  // No default: the trusted batch host owns the word
  // timeout policy, keeping a single source for the value.
  constructor(
    private readonly config: RuntimeModelConfig,
    private readonly timeoutMs: number,
    private readonly createClient: CreateLlmClient,
    private readonly logFailure?: (failure: VocabularyAnalysisFailure) => void
  ) {}
  async analyze(
    input: AnalyzeVocabularyInput & { systemPrompt: string }
  ): Promise<VocabularyAnalysisResult> {
    if (!this.config.configured) throw new VocabularyError('MODEL_NOT_CONFIGURED')
    const config = this.config
    let response: unknown = null
    let stage: VocabularyAnalysisFailure['stage'] = 'request'
    return abortableOperation<VocabularyAnalysisResult>(
      input.signal,
      this.timeoutMs,
      async (signal) => {
        try {
          const client = this.createClient(config)
          response = await client.complete(
            {
              model: config.modelId,
              messages: [
                {
                  role: 'system',
                  content: input.systemPrompt
                },
                {
                  role: 'user',
                  content: JSON.stringify({ term: input.term, wordLanguage: input.wordLanguage })
                }
              ],
              tools: vocabularyInsertTools(),
              ...toolRequestParams('single-tool-result', config)
            },
            { operation: 'vocabulary_analysis', timeoutMs: this.timeoutMs, signal }
          )
          stage = 'protocol'
          const parsed = parseSingleToolCallResponse(response)
          if (parsed.status === 'malformed-response')
            throw new VocabularyError('MODEL_ERROR', { cause: parsed.cause })
          if (parsed.status === 'invalid-tool-call')
            throw new VocabularyError('INVALID_ANALYSIS', { cause: parsed.cause })
          stage = 'tool-name'
          // 剩余为领域规则：只接受本领域工具名，不提取正文中的 SQL。
          if (
            parsed.toolName !== VOCABULARY_INSERT_TOOL_NAME &&
            parsed.toolName !== VOCABULARY_UNRECOGNIZED_TOOL_NAME
          ) {
            throw new VocabularyError('INVALID_ANALYSIS')
          }
          stage = 'arguments'
          if (parsed.toolName === VOCABULARY_UNRECOGNIZED_TOOL_NAME) {
            const result = unrecognizedToolArgumentsSchema.safeParse(parsed.arguments)
            if (!result.success) {
              throw new VocabularyError('INVALID_ANALYSIS', { cause: result.error })
            }
            return { status: 'unrecognized' }
          }
          return {
            status: 'insert',
            content: validateInsertArguments(parsed.arguments, input.term),
            modelId: config.modelId,
            promptVersion: VOCABULARY_PROMPT_VERSION
          }
        } catch (cause) {
          if (cause instanceof VocabularyError) throw cause
          if (isUnsupportedToolCall(cause)) {
            throw new VocabularyError('TOOL_CALL_NOT_SUPPORTED', { cause })
          }
          throw new VocabularyError(
            classifyModelRequestError(cause) === 'TIMEOUT' ? 'TIMEOUT' : 'MODEL_ERROR',
            { cause }
          )
        }
      }
    ).catch((error: unknown) => {
      if (!input.signal.aborted) {
        const cause = error instanceof Error ? error.cause : undefined
        try {
          this.logFailure?.({
            term: input.term,
            modelId: config.modelId,
            promptVersion: VOCABULARY_PROMPT_VERSION,
            code: error instanceof VocabularyError ? error.code : 'MODEL_ERROR',
            stage,
            reason:
              stage === 'request'
                ? classifyModelRequestError(cause ?? error)
                : stage === 'protocol'
                  ? 'Expected one function tool call, finish_reason=tool_calls, empty content/refusal and valid JSON arguments'
                  : stage === 'tool-name'
                    ? 'Unexpected vocabulary tool name'
                    : 'Vocabulary tool arguments failed validation',
            response,
            issues:
              cause instanceof ZodError
                ? cause.issues.map(({ path, code, message }) => ({ path, code, message }))
                : []
          })
        } catch {
          // 日志写入失败不能改变导入结果。
        }
      }
      throw error
    })
  }
}
