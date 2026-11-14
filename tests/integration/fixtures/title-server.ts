import { writeOrdinaryIntentIfRequested } from './conversation-intent-server'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'

export interface TitleRequest {
  messages: Array<{ role: string; content: string }>
  stream?: boolean
}

// Independent gates let desktop tests observe reply completion before a title,
// and exercise cancellation/crashes without a real provider or credentials.
export async function startTitleServer(holdReply = false): Promise<{
  baseUrl: string
  titles: TitleRequest[]
  replies: TitleRequest[]
  titleClosed(): boolean
  finishTitle(): void
  finishReply(): void
  close(): Promise<void>
}> {
  const titles: TitleRequest[] = []
  const replies: TitleRequest[] = []
  let finishTitle!: () => void
  let finishReply!: () => void
  let titleClosed = false
  const titleGate = new Promise<void>((resolve) => {
    finishTitle = resolve
  })
  const replyGate = new Promise<void>((resolve) => {
    finishReply = resolve
  })
  if (!holdReply) finishReply()
  const server = createServer((req, res) => {
    void (async () => {
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(chunk as Buffer)
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as TitleRequest
      if (writeOrdinaryIntentIfRequested(res, body.messages)) return
      const isTitle = body.messages[0].content.includes(
        'Generate a short, specific conversation title'
      )
      if (isTitle) {
        titles.push(body)
        res.once('close', () => {
          titleClosed = true
        })
      } else replies.push(body)
      await (isTitle ? titleGate : replyGate)
      if (res.destroyed) return
      const content = isTitle ? 'Coffee practice' : 'A reply.'
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      const delta = (value: object): string =>
        `data: ${JSON.stringify({ choices: [{ index: 0, delta: value, finish_reason: null }] })}\n\n`
      if (isTitle) res.write(delta({ reasoning_content: 'Ignore these thoughts.'.repeat(50) }))
      res.write(delta({ content }))
      res.write(
        `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`
      )
      res.end('data: [DONE]\n\n')
    })().catch(() => {
      res.destroy()
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  return {
    baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
    titles,
    replies,
    titleClosed: () => titleClosed,
    finishTitle,
    finishReply,
    close: async () => {
      finishTitle()
      finishReply()
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  }
}
