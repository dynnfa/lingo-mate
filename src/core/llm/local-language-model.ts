import type { LanguageModel, StreamReplyInput } from './language-model'

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
  async *streamReply({ messages, signal }: StreamReplyInput): AsyncIterable<string> {
    const latestMessage = messages.at(-1)?.content ?? ''
    const reply = `收到：“${latestMessage}”。这是本地开发模型的回复；下一步可通过 LanguageModel 接口接入真实模型。`

    for (const character of reply) {
      await delay(18, signal)
      yield character
    }
  }
}
