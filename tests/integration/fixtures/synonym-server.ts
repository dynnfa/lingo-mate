import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { randomUUID } from 'node:crypto'

export async function startSynonymServer(): Promise<{
  baseUrl: string
  prompts: string[]
  words: string[]
  close: () => Promise<void>
}> {
  const words: string[] = []
  const prompts: string[] = []
  const server = createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(chunk as Buffer)
      const body = JSON.parse(Buffer.concat(chunks).toString()) as {
        messages: Array<{ role: string; content?: string; tool_call_id?: string }>
      }
      prompts.push(body.messages.find((m) => m.role === 'system')!.content!)
      const input = JSON.parse(
        body.messages.find((message) => message.role === 'user')!.content!
      ) as { word: string }
      const toolResult =
        body.messages.at(-1)?.role === 'tool'
          ? (JSON.parse(body.messages.at(-1)!.content!) as {
              groups: Array<{ id: string }>
              nextCursor: string | null
            })
          : undefined
      let name: string
      let args: Record<string, unknown>
      if (!toolResult) {
        words.push(input.word)
        name = 'find_synonym_groups'
        args = { word: input.word, meaning: 'acceptable' }
      } else if (input.word === 'broken') {
        name = 'unknown_tool'
        args = {}
      } else if (input.word === 'slow') {
        await new Promise((resolve) => setTimeout(resolve, 1000))
        name = 'report_unrecognized_word'
        args = { word: input.word }
      } else if (toolResult.groups.length && input.word !== 'enormous') {
        name = 'add_synonym_to_group'
        args = {
          word: input.word,
          meaning: 'acceptable',
          distinction: 'ordinary usage',
          groupid: toolResult.groups[0].id
        }
      } else {
        name = 'create_synonym_group_and_add_word'
        args = {
          word: input.word,
          meaning: input.word === 'enormous' ? 'very large' : 'acceptable',
          distinction: 'ordinary usage',
          groupMeaning: input.word === 'enormous' ? 'very large' : 'acceptable'
        }
      }
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(
        JSON.stringify({
          id: randomUUID(),
          object: 'chat.completion',
          model: 'test-model',
          created: 1,
          choices: [
            {
              index: 0,
              finish_reason: 'tool_calls',
              message: {
                role: 'assistant',
                content: null,
                tool_calls: [
                  {
                    id: randomUUID(),
                    type: 'function',
                    function: { name, arguments: JSON.stringify(args) }
                  }
                ]
              }
            }
          ],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
        })
      )
    })().catch(() => {
      response.writeHead(500)
      response.end()
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })
  return {
    words,
    prompts,
    baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections()
        server.close((error) => (error ? reject(error) : resolve()))
      })
  }
}
