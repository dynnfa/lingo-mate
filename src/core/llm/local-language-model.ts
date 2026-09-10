import type { LanguageModel, ModelStreamEvent, StreamReplyInput } from './language-model'

const delay = (milliseconds: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException('The operation was aborted', 'AbortError'))
      return
    }

    const onAbort = (): void => {
      clearTimeout(timeout)
      signal.removeEventListener('abort', onAbort)
      reject(new DOMException('The operation was aborted', 'AbortError'))
    }

    const timeout = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, milliseconds)

    signal.addEventListener('abort', onAbort, { once: true })
  })

export class LocalLanguageModel implements LanguageModel {
  async *streamReply({
    messages,
    signal,
    promptKind
  }: StreamReplyInput): AsyncIterable<ModelStreamEvent> {
    const latestMessage = messages.at(-1)?.content ?? ''
    if (promptKind === 'conversation-title') {
      signal.throwIfAborted()
      yield { type: 'text', delta: latestMessage.replace(/\s+/g, ' ').trim().slice(0, 40) }
      return
    }
    // 本地开发模型模拟推理模型的节奏：先流出少量思考文本，再流式给出正文，
    // 供开发与端到端测试验证思考预览交互。
    const reasoning = `正在分析输入「${latestMessage}」，先确认意图再组织回复。`
    for (const character of reasoning) {
      await delay(12, signal)
      yield { type: 'reasoning', delta: character }
    }
    const reply = `收到：“${latestMessage}”。这是本地开发模型的回复；下一步可通过 LanguageModel 接口接入真实模型。`

    for (const character of reply) {
      await delay(18, signal)
      yield { type: 'text', delta: character }
    }
  }
}
