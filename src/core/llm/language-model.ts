export type ModelRole = 'user' | 'assistant'

export interface ModelMessage {
  role: ModelRole
  content: string
}

export interface StreamReplyInput {
  messages: ModelMessage[]
  // 调用方提供完整指令，显式声明各类自然语言输出所用的语言。
  // 传输适配器不识别命令，也不选择或组装 Agent Prompt。
  systemPrompt: string
  purpose: 'conversation' | 'conversation-title'
  signal: AbortSignal
}

// 模型流的可判别事件：text 是最终回复正文的增量，reasoning 是提供方
// 返回的思考文本或思考摘要增量，仅供等待期临时展示，不属于回复正文。
export type ModelStreamEvent =
  { type: 'text'; delta: string } | { type: 'reasoning'; delta: string }

export interface LanguageModel {
  streamReply(input: StreamReplyInput): AsyncIterable<ModelStreamEvent>
}
