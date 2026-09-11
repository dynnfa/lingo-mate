import { createServer, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

export interface SentencePracticeRequest {
  messages: Array<{ role: string; content: string | null }>
}

export interface SentencePracticeServer {
  baseUrl: string
  requests: SentencePracticeRequest[]
  // 客户端中止的挂起提示请求数（用于退出/切换菜单时验证在途请求被中止）。
  abortedHints: () => number
  close(): Promise<void>
}

interface RequestEntry {
  entryId: string
  term: string
  referenceMeaning?: string | null
}

interface RequestAnswer {
  entries?: RequestEntry[]
  answer?: string
}

// 造句练习假模型：提示请求按词条返回覆盖全部三个词的搭配提示；
// 点评请求按答案内容判定——含 "wrong" 的答案判 banana 未使用并给出
// 语法问题与改写，其余判全部正确。hangHints 用于在途请求的退出测试。
export async function startSentencePracticeServer(
  options: { hangHints?: boolean } = {}
): Promise<SentencePracticeServer> {
  const requests: SentencePracticeRequest[] = []
  let abortedHints = 0

  const jsonResponse = (res: ServerResponse, payload: unknown): void => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(
      JSON.stringify({
        id: 'sentence-practice-fixture',
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

  const server = createServer((req, res) => {
    void (async () => {
      const buffers: Buffer[] = []
      for await (const chunk of req) buffers.push(chunk as Buffer)
      const body = JSON.parse(Buffer.concat(buffers).toString('utf8')) as SentencePracticeRequest
      requests.push(body)
      const data = JSON.parse(body.messages[1].content ?? '{}') as RequestAnswer

      // 提示请求：entries 存在且没有答案字段。
      if (data.entries && data.answer === undefined) {
        if (options.hangHints) {
          // 保持挂起，供在途取消/退出测试；连接被客户端关闭时计数。
          res.on('close', () => {
            abortedHints += 1
          })
          return
        }
        const entries = data.entries
        jsonResponse(res, {
          hints: entries.map((entry) => ({
            entryIds: [entry.entryId],
            phrase: `a good ${entry.term}`,
            explanation: `关于 ${entry.term} 的常用搭配`
          }))
        })
        return
      }

      // 点评请求：按答案内容给出确定性判定。
      if (/wrong/i.test(data.answer ?? '')) {
        const entries = data.entries ?? []
        jsonResponse(res, {
          wordUsage: entries.map((entry, index) => ({
            entryId: entry.entryId,
            used: index !== 1,
            correct: index !== 1,
            feedback: index === 1 ? `${entry.term} 没有出现在句子中。` : `${entry.term} 使用正确。`
          })),
          fluency: { natural: false, feedback: '句子整体不够自然。' },
          grammar: {
            correct: false,
            issues: [
              {
                original: 'a wrong sentence',
                suggestion: 'the wrong sentence',
                explanation: '冠词使用不当。'
              }
            ]
          },
          summary: '漏用了 banana，且有一处语法问题。',
          revisedAnswer: 'Everything is used correctly now.'
        })
        return
      }
      const entries = data.entries ?? []
      jsonResponse(res, {
        wordUsage: entries.map((entry) => ({
          entryId: entry.entryId,
          used: true,
          correct: true,
          feedback: `${entry.term} 使用正确。`
        })),
        fluency: { natural: true, feedback: '句子整体通顺自然。' },
        grammar: { correct: true, issues: [] },
        summary: '全部正确，表达通顺。',
        revisedAnswer: null
      })
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
    abortedHints: () => abortedHints,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      })
  }
}
