import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'

export interface ConceptRequest {
  messages: Array<{ role: string; content: string }>
  tools?: unknown[]
  stream?: boolean
}

// Captures actual vendor-bound instructions; no external model or credentials.
export async function startConceptServer(): Promise<{
  baseUrl: string
  requests: ConceptRequest[]
  close(): Promise<void>
}> {
  const requests: ConceptRequest[] = []
  const server = createServer((req, res) => {
    void (async () => {
      const buffers: Buffer[] = []
      for await (const chunk of req) buffers.push(chunk as Buffer)
      const body = JSON.parse(Buffer.concat(buffers).toString('utf8')) as ConceptRequest
      const isConcept = body.messages[0].content.includes('the /concept command')
      if (isConcept) requests.push(body)
      const text = isConcept ? 'A concept explanation.' : 'Concept session'
      if (!body.stream) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: text } }] }))
        return
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      for (const content of [text.slice(0, 10), text.slice(10)]) {
        res.write(
          `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content }, finish_reason: null }] })}\n\n`
        )
      }
      res.write(
        `data: ${JSON.stringify({
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
        })}\n\n`
      )
      res.end('data: [DONE]\n\n')
    })().catch(() => {
      if (!res.destroyed) {
        res.writeHead(400)
        res.end()
      }
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  return {
    baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
    requests,
    close: async () => {
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  }
}
