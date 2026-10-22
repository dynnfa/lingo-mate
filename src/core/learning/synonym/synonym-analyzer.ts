import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions'

export interface SynonymModelTurn {
  message: {
    content?: string | null
    refusal?: string | null
    reasoning_content?: string
    tool_calls: Array<{
      id: string
      type: 'function'
      function: { name: string; arguments: string }
    }>
  }
  canCorrectParallel: boolean
}

// One provider request only; Python owns the loop. Transcript and provider fields stay in TS.
export interface SynonymAnalyzer {
  analyze(input: {
    messages: ChatCompletionMessageParam[]
    signal: AbortSignal
  }): Promise<SynonymModelTurn>
}
