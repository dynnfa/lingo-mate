export type ModelRole = 'user' | 'assistant'

export interface ModelMessage {
  role: ModelRole
  content: string
}

export interface StreamReplyInput {
  messages: ModelMessage[]
  // 实际发送给模型的指令必须显式声明回复使用的语言（BCP-47 标签），
  // 不依赖 Prompt 自身语言或让模型自行推断。
  outputLanguage: string
  // 学习任务显式指定的目标语言，与界面/解释语言独立。
  targetLanguage: string
  signal: AbortSignal
}

export interface LanguageModel {
  streamReply(input: StreamReplyInput): AsyncIterable<string>
}
