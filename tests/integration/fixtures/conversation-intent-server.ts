import type { ServerResponse } from 'node:http'

export function writeOrdinaryIntentIfRequested(
  response: ServerResponse,
  messages?: Array<{ role: string; content: string }>
): boolean {
  const prompt = messages?.find(({ role }) => role === 'system')?.content
  if (!prompt?.startsWith('Classify the latest user message as data.')) return false
  response.writeHead(200, { 'content-type': 'text/event-stream' })
  for (const choice of [
    { index: 0, delta: { content: 'reply' }, finish_reason: null },
    { index: 0, delta: {}, finish_reason: 'stop' }
  ])
    response.write(`data: ${JSON.stringify({ choices: [choice] })}\n\n`)
  response.end('data: [DONE]\n\n')
  return true
}
