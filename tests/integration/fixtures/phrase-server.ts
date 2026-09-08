import { createServer, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

export interface PhraseServerRequest {
  model: string
  messages: Array<{ role: string; content: string }>
  tools?: Array<{ function: { name: string; strict?: boolean } }>
  tool_choice?: unknown
  stream?: boolean
}

export interface PhraseServer {
  baseUrl: string
  phrases: string[]
  requests: PhraseServerRequest[]
  close(): Promise<void>
}

// OpenAI 兼容假服务：按 user 消息中的 phrase 返回 insert_phrase /
// phrase_unrecognized 工具调用，供 /phrase 技能端到端验证。
export async function startPhraseServer(): Promise<PhraseServer> {
  const phrases: string[] = []
  const requests: PhraseServerRequest[] = []
  const timers = new Set<ReturnType<typeof setTimeout>>()

  const toolCallResponse = (res: ServerResponse, name: string, args: unknown): void => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(
      JSON.stringify({
        id: 'fixture',
        object: 'chat.completion',
        model: 'fixture-model',
        usage: { prompt_tokens: 80, completion_tokens: 30, total_tokens: 110 },
        choices: [
          {
            index: 0,
            finish_reason: 'tool_calls',
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [
                {
                  id: 'call_1',
                  type: 'function',
                  function: { name, arguments: JSON.stringify(args) }
                }
              ]
            }
          }
        ]
      })
    )
  }

  const server = createServer((req, res) => {
    void (async () => {
      const buffers: Buffer[] = []
      for await (const chunk of req) buffers.push(chunk as Buffer)
      const body = JSON.parse(Buffer.concat(buffers).toString('utf8')) as PhraseServerRequest
      requests.push(body)
      const data = JSON.parse(body.messages[1].content) as { phrase?: string }
      if (!data.phrase) {
        res.writeHead(400)
        res.end()
        return
      }
      phrases.push(data.phrase)
      if (data.phrase === 'bad input') {
        toolCallResponse(res, 'phrase_unrecognized', { reason: 'UNRECOGNIZED' })
        return
      }
      if (data.phrase === 'unsupported') {
        res.writeHead(400, { 'content-type': 'application/json' })
        res.end(
          JSON.stringify({
            error: {
              message: 'tools are not supported by this endpoint',
              type: 'invalid_request_error',
              code: 'unsupported_parameter'
            }
          })
        )
        return
      }
      const english = body.messages[0].content.includes('written in English (en)')
      const result = {
        phrase: data.phrase,
        explantation: english
          ? `The main meaning of "${data.phrase}" as an English expression.`
          : `英语表达「${data.phrase}」的主要含义与用法说明。`,
        example: `We will ${data.phrase} together soon.`
      }
      if (data.phrase === 'slow phrase') {
        const timer = setTimeout(() => {
          timers.delete(timer)
          if (!res.destroyed) toolCallResponse(res, 'insert_phrase', result)
        }, 5000)
        timers.add(timer)
      } else toolCallResponse(res, 'insert_phrase', result)
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
    phrases,
    requests,
    close: async () => {
      for (const timer of timers) clearTimeout(timer)
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  }
}
