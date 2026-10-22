import { createServer, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

export interface ExplorePhraseServerRequest {
  model: string
  messages: Array<{ role: string; content: string }>
  tools?: Array<{ function: { name: string } }>
  stream?: boolean
}

export interface ExplorePhraseServer {
  baseUrl: string
  requests: ExplorePhraseServerRequest[]
  close(): Promise<void>
}

// OpenAI 兼容假服务：解析 user 消息中的 count 与 excludedPhrases，返回
// submit_explored_phrases 工具调用（恰好 count 个不重复候选），
// 供 /explore-phrase 技能端到端验证。
export async function startExplorePhraseServer(
  options: { firstCount?: number; hangAtRequest?: number } = {}
): Promise<ExplorePhraseServer> {
  const requests: ExplorePhraseServerRequest[] = []
  let sequence = 0

  const respond = (res: ServerResponse, items: unknown[]): void => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(
      JSON.stringify({
        id: 'fixture',
        object: 'chat.completion',
        model: 'fixture-model',
        usage: { prompt_tokens: 120, completion_tokens: 200, total_tokens: 320 },
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
                  function: {
                    name: 'submit_explored_phrases',
                    arguments: JSON.stringify({ items })
                  }
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
      const body = JSON.parse(Buffer.concat(buffers).toString('utf8')) as ExplorePhraseServerRequest
      requests.push(body)
      const data = JSON.parse(
        body.messages.find((message) => message.role === 'user')?.content ?? '{}'
      ) as { count?: number; excludedPhrases?: string[] }
      if (requests.length === options.hangAtRequest) return
      const count =
        requests.length === 1
          ? Math.min(data.count ?? 10, options.firstCount ?? 10)
          : (data.count ?? 10)
      const excluded = new Set(data.excludedPhrases ?? [])
      const items: Array<{ phrase: string; explanation: string; example: string }> = []
      while (items.length < count) {
        sequence += 1
        const phrase = `e2e phrase ${sequence}`
        if (excluded.has(phrase)) continue
        items.push({
          phrase,
          explanation: `第 ${sequence} 个短语的释义。`,
          example: `This sentence uses e2e phrase ${sequence} naturally.`
        })
      }
      respond(res, items)
    })()
  })
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve)
  })
  const { port } = server.address() as AddressInfo
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve()))
  }
}
