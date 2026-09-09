import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type {
  ChatCompletion,
  ChatCompletionChunk,
  ChatCompletionCreateParamsNonStreaming
} from 'openai/resources/chat/completions'
import { ModelRequestError, type LlmClientConfig } from './llm-client'

const partSchema = z
  .object({
    text: z.string().optional(),
    thought: z.boolean().optional(),
    thoughtSignature: z.string().optional(),
    functionCall: z
      .object({
        name: z.string(),
        args: z.record(z.string(), z.unknown()).optional(),
        id: z.string().optional()
      })
      .optional()
  })
  .passthrough()
const responseSchema = z.object({
  responseId: z.string().optional(),
  modelVersion: z.string().optional(),
  candidates: z
    .array(
      z.object({
        index: z.number().int().nonnegative().optional(),
        content: z.object({ parts: z.array(partSchema).optional() }).optional(),
        finishReason: z.string().optional()
      })
    )
    .optional(),
  usageMetadata: z
    .object({
      promptTokenCount: z.number().int().nonnegative().optional(),
      candidatesTokenCount: z.number().int().nonnegative().optional(),
      thoughtsTokenCount: z.number().int().nonnegative().optional(),
      totalTokenCount: z.number().int().nonnegative().optional()
    })
    .optional()
})
type Part = z.infer<typeof partSchema>
type Params = Omit<ChatCompletionCreateParamsNonStreaming, 'stream'>

// Converts the application's text/tool contract at the network boundary. Original model
// parts stay request-local so signatures survive tool rounds without entering the UI.
export class GeminiTransport {
  private readonly calls = new Map<string, { name: string; parts: Part[]; providerId?: string }>()
  constructor(private readonly config: LlmClientConfig) {}

  private body(params: Params): unknown {
    const contents: { role: string; parts: unknown[] }[] = []
    const system: unknown[] = []
    for (const message of params.messages) {
      const textParts =
        typeof message.content === 'string'
          ? [{ text: message.content }]
          : (message.content ?? []).map((part) => {
              if (part.type !== 'text')
                throw new ModelRequestError(
                  'PROTOCOL',
                  new Error('Unsupported Gemini content part')
                )
              return { text: part.text }
            })
      if (message.role === 'system' || message.role === 'developer') {
        system.push(...textParts)
        continue
      }
      let parts: unknown[] = textParts
      if (message.role === 'tool') {
        const call = this.calls.get(message.tool_call_id)
        if (!call) throw new ModelRequestError('PROTOCOL', new Error('Unknown Gemini tool call'))
        const result: unknown = JSON.parse(String(message.content))
        parts = [
          {
            functionResponse: {
              name: call.name,
              ...(call.providerId ? { id: call.providerId } : {}),
              response:
                typeof result === 'object' && result !== null && !Array.isArray(result)
                  ? result
                  : { result }
            }
          }
        ]
      } else if (message.role === 'assistant' && message.tool_calls?.length) {
        const original = this.calls.get(message.tool_calls[0].id)
        if (!original)
          throw new ModelRequestError('PROTOCOL', new Error('Unknown Gemini model turn'))
        parts = original.parts
      }
      const role = message.role === 'assistant' ? 'model' : 'user'
      const previous = contents.at(-1)
      if (previous?.role === role) previous.parts.push(...parts)
      else contents.push({ role, parts })
    }
    const declarations = params.tools?.map((tool) => {
      if (tool.type !== 'function')
        throw new ModelRequestError('PROTOCOL', new Error('Unsupported Gemini tool'))
      return {
        name: tool.function.name,
        description: tool.function.description,
        parametersJsonSchema: tool.function.parameters
      }
    })
    const choice = params.tool_choice
    const toolConfig = choice
      ? {
          functionCallingConfig: {
            mode:
              choice === 'none'
                ? 'NONE'
                : choice === 'required' || typeof choice === 'object'
                  ? 'ANY'
                  : 'AUTO',
            ...(typeof choice === 'object' && choice.type === 'function'
              ? { allowedFunctionNames: [choice.function.name] }
              : {})
          }
        }
      : undefined
    return {
      contents,
      ...(system.length ? { systemInstruction: { parts: system } } : {}),
      ...(declarations?.length
        ? { tools: [{ functionDeclarations: declarations }], toolConfig }
        : {}),
      generationConfig: {
        temperature: params.temperature ?? undefined,
        topP: params.top_p ?? undefined,
        maxOutputTokens: params.max_completion_tokens ?? params.max_tokens ?? undefined,
        stopSequences: typeof params.stop === 'string' ? [params.stop] : (params.stop ?? undefined),
        candidateCount: params.n ?? undefined
      }
    }
  }

  private async request(
    params: Params,
    signal: AbortSignal,
    streaming: boolean
  ): Promise<Response> {
    const model = encodeURIComponent(params.model.replace(/^models\//, ''))
    const url = `${this.config.baseUrl.replace(/\/+$/, '')}/models/${model}:${streaming ? 'streamGenerateContent?alt=sse' : 'generateContent'}`
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (this.config.apiKey) {
      headers['x-api-key'] = this.config.apiKey
      headers['x-goog-api-key'] = this.config.apiKey
    }
    let response: Response
    const body = JSON.stringify(this.body(params))
    try {
      // Never forward custom API-key headers through redirects.
      response = await fetch(url, { method: 'POST', headers, body, signal, redirect: 'error' })
    } catch (cause) {
      throw new ModelRequestError('NETWORK', cause)
    }
    if (!response.ok) {
      await response.body?.cancel()
      throw new ModelRequestError(
        response.status === 401 || response.status === 403
          ? 'AUTH'
          : response.status === 404
            ? 'MODEL_UNAVAILABLE'
            : 'UNKNOWN',
        new Error(`Gemini HTTP ${response.status}`)
      )
    }
    return response
  }

  private convert(raw: unknown, model: string, streaming: boolean): ChatCompletion {
    const parsed = responseSchema.safeParse(raw)
    if (!parsed.success) throw new ModelRequestError('PROTOCOL', parsed.error)
    const value = parsed.data
    if (!value.candidates?.length && (!streaming || !value.usageMetadata)) {
      throw new ModelRequestError('PROTOCOL', new Error('Gemini response has no candidates'))
    }
    const usage = value.usageMetadata
    return {
      id: value.responseId ?? randomUUID(),
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: value.modelVersion ?? model,
      ...(usage
        ? {
            usage: {
              prompt_tokens: usage.promptTokenCount,
              completion_tokens:
                usage.candidatesTokenCount === undefined
                  ? undefined
                  : usage.candidatesTokenCount + (usage.thoughtsTokenCount ?? 0),
              total_tokens: usage.totalTokenCount
            } as ChatCompletion['usage']
          }
        : {}),
      choices: (value.candidates ?? []).map((candidate) => {
        const parts = candidate.content?.parts ?? []
        const toolCalls = parts.flatMap((part) => {
          if (!part.functionCall) return []
          const id = randomUUID()
          this.calls.set(id, {
            name: part.functionCall.name,
            providerId: part.functionCall.id,
            parts
          })
          return [
            {
              id,
              type: 'function' as const,
              function: {
                name: part.functionCall.name,
                arguments: JSON.stringify(part.functionCall.args ?? {})
              }
            }
          ]
        })
        const reason = candidate.finishReason
        const finish =
          reason === 'STOP'
            ? toolCalls.length
              ? 'tool_calls'
              : 'stop'
            : reason === 'MAX_TOKENS'
              ? 'length'
              : reason
                ? 'content_filter'
                : null
        if (!streaming && finish === null)
          throw new ModelRequestError('PROTOCOL', new Error('Missing Gemini finish reason'))
        return {
          index: candidate.index ?? 0,
          logprobs: null,
          finish_reason: finish as ChatCompletion.Choice['finish_reason'],
          message: {
            role: 'assistant',
            refusal: null,
            content:
              parts
                .filter((part) => !part.thought)
                .map((part) => part.text ?? '')
                .join('') || null,
            ...(toolCalls.length ? { tool_calls: toolCalls } : {})
          }
        }
      })
    }
  }

  async complete(params: Params, signal: AbortSignal): Promise<ChatCompletion> {
    const response = await this.request(params, signal, false)
    return this.convert(await response.json(), params.model, false)
  }

  async stream(
    params: Params,
    signal: AbortSignal
  ): Promise<{ data: AsyncIterable<ChatCompletionChunk>; response: Response }> {
    const response = await this.request(params, signal, true)
    return { response, data: this.chunks(response, params.model) }
  }

  private async *chunks(response: Response, model: string): AsyncGenerator<ChatCompletionChunk> {
    if (!response.body) throw new ModelRequestError('PROTOCOL', new Error('Missing Gemini stream'))
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let data: string[] = []
    let finished = false
    const convertEvent = (): ChatCompletionChunk | undefined => {
      if (!data.length) return undefined
      const raw = data.join('\n')
      data = []
      const completion = this.convert(JSON.parse(raw), model, true)
      if (completion.choices.some((choice) => choice.finish_reason !== null)) finished = true
      return {
        ...completion,
        object: 'chat.completion.chunk',
        choices: completion.choices.map((choice) => ({
          index: choice.index,
          finish_reason: choice.finish_reason,
          logprobs: null,
          delta: {
            content: choice.message.content,
            ...(choice.message.tool_calls
              ? { tool_calls: choice.message.tool_calls.map((call, index) => ({ ...call, index })) }
              : {})
          }
        }))
      }
    }
    try {
      while (true) {
        const next = await reader.read()
        buffer += decoder.decode(next.value, { stream: !next.done })
        let end: number
        while ((end = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, end).replace(/\r$/, '')
          buffer = buffer.slice(end + 1)
          if (!line) {
            const chunk = convertEvent()
            if (chunk) yield chunk
          } else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''))
        }
        if (next.done) break
      }
      if (!finished || buffer.trim() || data.length)
        throw new ModelRequestError('PROTOCOL', new Error('Truncated Gemini SSE event'))
    } finally {
      await reader.cancel().catch(() => {})
      reader.releaseLock()
    }
  }
}
