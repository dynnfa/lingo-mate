import { expect, it, vi } from 'vitest'
import { PythonAgentRuntime } from '../python-agent-runtime'
import { ControlledProcess, sentRun, tick } from './runtime-fixture'

const input = {
  mode: 'desktop',
  text: '/tts Speak this',
  outputLanguage: 'zh-CN',
  targetLanguage: 'en',
  signal: new AbortController().signal
} as const

it.each([
  { kind: 'reply' },
  { kind: 'workflow', workflow: 'sentence' },
  { kind: 'invalid', workflow: 'tts' }
] as const)('rejects forged route %j for a valid command', async (result) => {
  const child = new ControlledProcess()
  const model = vi.fn()
  const runtime = new PythonAgentRuntime(child, model)
  const routing = runtime.routeConversation(input)
  const rejected = expect(routing).rejects.toMatchObject({ code: 'AGENT_PROTOCOL_ERROR' })
  await tick()
  const { runId } = sentRun(child)
  child.emit({ type: 'conversation_route_result', runId, result })
  await rejected
  expect(model).not.toHaveBeenCalled()
})

it('rejects a channel reply routed to a writing workflow', async () => {
  const child = new ControlledProcess()
  const runtime = new PythonAgentRuntime(child, vi.fn())
  const routing = runtime.routeConversation({ ...input, mode: 'channel-chat' })
  const rejected = expect(routing).rejects.toMatchObject({ code: 'AGENT_PROTOCOL_ERROR' })
  await tick()
  const { runId } = sentRun(child)
  child.emit({
    type: 'conversation_route_result',
    runId,
    result: { kind: 'workflow', workflow: 'tts' }
  })
  await rejected
})

it('allows classification only for desktop natural language and binds the terminal to its receipt', async () => {
  const child = new ControlledProcess()
  const streamReply = vi.fn(async function* () {
    yield { type: 'reasoning', delta: 'private' } as const
    yield { type: 'text', delta: 'unclear' } as const
  })
  const runtime = new PythonAgentRuntime(child, () => ({ streamReply }))
  const routing = runtime.routeConversation({ ...input, text: 'Explain that' })
  const rejected = expect(routing).rejects.toMatchObject({ code: 'AGENT_PROTOCOL_ERROR' })
  await tick()
  const { runId, snapshot } = sentRun(child)
  expect(JSON.stringify(snapshot)).not.toContain('Explain that')
  child.emit({
    type: 'host_call',
    operation: 'model.classify-conversation',
    args: { systemPrompt: 'Return an intent label in English.' },
    runId,
    callId: `${runId}:classify`
  })
  await tick()
  expect(child.sent.filter(({ type }) => type === 'host_result')).toEqual([
    expect.objectContaining({ result: { intent: 'unclear' } })
  ])
  expect(child.sent.some(({ type }) => type === 'host_chunk')).toBe(false)
  expect(streamReply).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      messages: [{ role: 'user', content: 'Explain that' }],
      timeoutMs: 10_000
    })
  )
  child.emit({
    type: 'conversation_route_result',
    runId,
    result: { kind: 'workflow', workflow: 'concept' }
  })
  await rejected
})
