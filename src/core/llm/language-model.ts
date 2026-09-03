export type ModelRole = 'user' | 'assistant'

export interface ModelMessage {
  role: ModelRole
  content: string
}

export interface StreamReplyInput {
  messages: ModelMessage[]
  signal: AbortSignal
}

export interface LanguageModel {
  streamReply(input: StreamReplyInput): AsyncIterable<string>
}
