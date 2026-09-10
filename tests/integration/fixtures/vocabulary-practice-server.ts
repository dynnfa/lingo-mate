import { createServer, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

export interface PracticeRequest {
  tools?: Array<{ function: { name: string } }>
  tool_choice?: unknown
  messages: Array<{ role: string; content: string | null; tool_calls?: unknown[] }>
}

export interface VocabularyPracticeServer {
  baseUrl: string
  requests: PracticeRequest[]
  close(): Promise<void>
}

interface PracticeEntry {
  entryId: string
  term: string
  submittedMeaning: string
  referenceMeaning: string | null
}

// 词汇练习假模型：把 submittedMeaning 中含 "wrong" 的条目标红，
// 首轮以 mark_text_red 工具调用响应，收到工具结果后输出最终 JSON 反馈；
// 全部正确时不调用工具，直接给出 all_correct 反馈。
export async function startVocabularyPracticeServer(): Promise<VocabularyPracticeServer> {
  const requests: PracticeRequest[] = []

  const jsonResponse = (res: ServerResponse, payload: unknown): void => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(
      JSON.stringify({
        id: 'practice-fixture',
        object: 'chat.completion',
        model: 'fixture-model',
        usage: { prompt_tokens: 60, completion_tokens: 12, total_tokens: 72 },
        choices: [
          {
            index: 0,
            finish_reason: 'stop',
            message: { role: 'assistant', content: JSON.stringify(payload) }
          }
        ]
      })
    )
  }

  const toolCallResponse = (
    res: ServerResponse,
    items: Array<{ entryId: string; field: 'meaning'; reason: string }>
  ): void => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(
      JSON.stringify({
        id: 'practice-fixture',
        object: 'chat.completion',
        model: 'fixture-model',
        usage: { prompt_tokens: 60, completion_tokens: 12, total_tokens: 72 },
        choices: [
          {
            index: 0,
            finish_reason: 'tool_calls',
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [
                {
                  id: 'mark_1',
                  type: 'function',
                  function: { name: 'mark_text_red', arguments: JSON.stringify({ items }) }
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
      const body = JSON.parse(Buffer.concat(buffers).toString('utf8')) as PracticeRequest
      requests.push(body)
      // 已有工具结果的轮次：输出最终 JSON 反馈（不再重复同一 tool call id）。
      if (body.messages.some((message) => message.role === 'tool')) {
        jsonResponse(res, {
          verdict: 'has_errors',
          summary: 'One meaning is wrong and has been marked.'
        })
        return
      }
      const data = JSON.parse(body.messages[1].content) as { entries: PracticeEntry[] }
      const wrong = data.entries.filter((entry) => /wrong/i.test(entry.submittedMeaning))
      if (wrong.length > 0) {
        toolCallResponse(
          res,
          wrong.map((entry) => ({
            entryId: entry.entryId,
            field: 'meaning' as const,
            reason: `The meaning of ${entry.term} does not match.`
          }))
        )
        return
      }
      jsonResponse(res, { verdict: 'all_correct', summary: 'Every meaning is correct.' })
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
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      })
  }
}
