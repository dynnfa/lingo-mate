import { createServer, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { ANALYSIS } from '../../../src/core/learning/vocabulary/__tests__/fixtures'

export interface VocabularyServer {
  baseUrl: string
  terms: string[]
  requests: Array<{
    model: string
    messages: Array<{ role: string; content: string }>
    response_format: unknown
  }>
  close(): Promise<void>
}
export async function startVocabularyServer(): Promise<VocabularyServer> {
  const terms: string[] = []
  const requests: VocabularyServer['requests'] = []
  const timers = new Set<ReturnType<typeof setTimeout>>()
  const respond = (res: ServerResponse, content: unknown): void => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(
      JSON.stringify({
        id: 'fixture',
        object: 'chat.completion',
        choices: [
          {
            index: 0,
            finish_reason: 'stop',
            message: { role: 'assistant', content: JSON.stringify(content) }
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
      ) as VocabularyServer['requests'][number]
      requests.push(body)
      const data = JSON.parse(body.messages[1].content) as { term: string }
      terms.push(data.term)
      if (data.term === 'service-error') {
        res.writeHead(503)
        res.end('fixture provider error')
        return
      }
      if (data.term === 'bad') {
        respond(res, { status: 'unrecognized', analysis: null })
        return
      }
      const analysis = structuredClone(ANALYSIS)
      const english = body.messages[0].content.includes('written in English (en)')
      const meanings: Record<string, { ipa: string; en: string; zh: string }> = {
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
      const meaning = meanings[data.term] ?? meanings.apple
      analysis.senses[0].definition = english ? meaning.en : meaning.zh
      analysis.pronunciations[0].ipa = meaning.ipa
      analysis.pronunciations[0].guidance = english
        ? 'Follow the stress mark before the stressed syllable.'
        : '重读音节前带有重音标记。'

      if (data.term === 'invalid') analysis.pronunciations[0].senseIds = ['s5']
      const result = { status: 'recognized', analysis }
      if (data.term === 'slow') {
        const timer = setTimeout(() => {
          timers.delete(timer)
          if (!res.destroyed) respond(res, result)
        }, 5000)
        timers.add(timer)
      } else respond(res, result)
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
