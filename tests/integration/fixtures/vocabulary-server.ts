import { createServer, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { VOCABULARY_INSERT_SQL } from '../../../src/core/learning/vocabulary/vocabulary-insert'

export interface VocabularyServerRequest {
  model: string
  messages: Array<{ role: string; content: string }>
  tools?: Array<{ function: { name: string; strict?: boolean } }>
  tool_choice?: unknown
  response_format?: unknown
  stream?: boolean
  parallel_tool_calls?: boolean
}

export interface VocabularyServer {
  baseUrl: string
  terms: string[]
  requests: VocabularyServerRequest[]
  close(): Promise<void>
}

// 单词内容 fixture：ipa 与双语释义按系统消息中的输出语言指令选择。
const MEANINGS: Record<string, { ipa: string; en: string; zh: string }> = {
  apple: {
    ipa: '/ˈæpəl/',
    en: 'A round fruit with red or green skin.',
    zh: '一种通常为红色或绿色果皮的圆形水果。'
  },
  banana: {
    ipa: '/bəˈnænə/',
    en: 'A long curved fruit with yellow skin.',
    zh: '一种长而弯曲、果皮通常为黄色的水果。'
  },
  orange: {
    ipa: '/ˈɔɹɪndʒ/',
    en: 'A citrus fruit with orange skin.',
    zh: '一种果皮为橙色的柑橘类水果。'
  }
}

export async function startVocabularyServer(): Promise<VocabularyServer> {
  const terms: string[] = []
  const requests: VocabularyServerRequest[] = []
  const timers = new Set<ReturnType<typeof setTimeout>>()

  const toolCallResponse = (res: ServerResponse, name: string, args: unknown): void => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(
      JSON.stringify({
        id: 'fixture',
        object: 'chat.completion',
        model: 'fixture-model',
        usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
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
      const body = JSON.parse(Buffer.concat(buffers).toString('utf8')) as VocabularyServerRequest
      requests.push(body)
      const data = JSON.parse(body.messages[1].content) as { term?: string }
      if (!data.term) {
        res.writeHead(400)
        res.end()
        return
      }
      terms.push(data.term)
      if (data.term === 'service-error') {
        res.writeHead(503)
        res.end('fixture provider error')
        return
      }
      if (data.term === 'unsupported') {
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
      if (data.term === 'bad') {
        toolCallResponse(res, 'vocabulary_unrecognized', { reason: 'UNRECOGNIZED' })
        return
      }
      if (data.term === 'invalid') {
        // 参数化内容非法（例句不是 JSON 数组），应用必须拒绝且不写库。
        toolCallResponse(res, 'insert_vocabulary', {
          sql: VOCABULARY_INSERT_SQL,
          parameters: {
            term: 'invalid',
            phonetic: '/ˈɪnvəlɪd/',
            meaning: 'A malformed fixture entry.',
            concept: 'The example_sentences field is not valid JSON.',
            example_sentences: 'not json'
          }
        })
        return
      }
      const english = body.messages[0].content.includes('written in English (en)')
      const meaning = MEANINGS[data.term] ?? MEANINGS.apple
      const result = {
        sql: VOCABULARY_INSERT_SQL,
        parameters: {
          term: data.term,
          phonetic: meaning.ipa,
          meaning: english ? meaning.en : meaning.zh,
          concept: english
            ? 'The fruit as everyday food in shopping and meals.'
            : '作为日常饮食和购物场景中的水果。',
          example_sentences: JSON.stringify([`I ate an ${data.term} after lunch.`])
        }
      }
      if (data.term === 'slow') {
        const timer = setTimeout(() => {
          timers.delete(timer)
          if (!res.destroyed) toolCallResponse(res, 'insert_vocabulary', result)
        }, 5000)
        timers.add(timer)
      } else toolCallResponse(res, 'insert_vocabulary', result)
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
    terms,
    requests,
    close: async () => {
      for (const timer of timers) clearTimeout(timer)
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  }
}
