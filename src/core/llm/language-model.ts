export type ModelRole = 'user' | 'assistant'

export interface ModelMessage {
  role: ModelRole
  content: string
}

// 本次回复使用的系统提示词形态：普通对话，或 `/concept` 单词概念讲解。
// 由调用方依据被回复的消息决定；缺省为普通对话。
export type ReplyPromptKind = 'conversation' | 'word-concept' | 'conversation-title'

export interface StreamReplyInput {
  messages: ModelMessage[]
  // 实际发送给模型的指令必须显式声明回复使用的语言（BCP-47 标签），
  // 不依赖 Prompt 自身语言或让模型自行推断。
  outputLanguage: string
  // 学习任务显式指定的目标语言，与界面/解释语言独立。
  targetLanguage: string
  promptKind?: ReplyPromptKind
  signal: AbortSignal
}

// 模型流的可判别事件：text 是最终回复正文的增量，reasoning 是提供方
// 返回的思考文本或思考摘要增量，仅供等待期临时展示，不属于回复正文。
export type ModelStreamEvent =
  { type: 'text'; delta: string } | { type: 'reasoning'; delta: string }

export interface LanguageModel {
  streamReply(input: StreamReplyInput): AsyncIterable<ModelStreamEvent>
}
