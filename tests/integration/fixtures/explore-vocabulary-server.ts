import { createServer, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

export interface ExploreVocabularyServerRequest {
  model: string
  messages: Array<{ role: string; content: string }>
  tools?: Array<{ function: { name: string } }>
  stream?: boolean
}

export interface ExploreVocabularyServer {
  baseUrl: string
  requests: ExploreVocabularyServerRequest[]
  close(): Promise<void>
}

// OpenAI 兼容假服务：解析 user 消息中的 count 与 excludedTerms，返回
// submit_explored_vocabulary 工具调用（恰好 count 个不重复候选），
// 供 /explore-vocabulary 技能端到端验证。词条必须符合词形规则：无空格、
// 无数字，因此用纯字母的二十六进制序号生成唯一单词。
export async function startExploreVocabularyServer(): Promise<ExploreVocabularyServer> {
  const requests: ExploreVocabularyServerRequest[] = []
  let sequence = 0

  // 1 → a，26 → z，27 → aa：纯字母、无数字、词内无分隔符。
  const lettersOf = (value: number): string => {
    let letters = ''
    let rest = value
    while (rest > 0) {
      const digit = (rest - 1) % 26
      letters = String.fromCharCode(97 + digit) + letters
      rest = Math.floor((rest - 1) / 26)
    }
    return letters
  }

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
                    name: 'submit_explored_vocabulary',
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
      const body = JSON.parse(
        Buffer.concat(buffers).toString('utf8')
      ) as ExploreVocabularyServerRequest
      requests.push(body)
      const data = JSON.parse(
        body.messages.find((message) => message.role === 'user')?.content ?? '{}'
      ) as { count?: number; excludedTerms?: string[] }
      const count = data.count ?? 10
      const excluded = new Set(data.excludedTerms ?? [])
      const items: Array<{ term: string; explanation: string; example: string }> = []
      while (items.length < count) {
        sequence += 1
        // 前缀必须同样无数字：含数字的词条会被词形规则拒绝。
        const term = `eeword${lettersOf(sequence)}`
        if (excluded.has(term)) continue
        items.push({
          term,
          explanation: `第 ${sequence} 个单词的释义。`,
          example: `This sentence uses ${term} naturally.`
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
