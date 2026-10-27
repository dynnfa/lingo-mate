import { expect, it, vi } from 'vitest'
import { boundHost, noop, signal } from './task-fixture'

it('runs only the bound synthesis with no model dependency and verifies its completion', async () => {
  const synthesize = vi.fn(async () => ({ completed: true as const }))
  const verifyCompletion = vi.fn()
  const { host, binding } = boundHost({ task: 'tts', host: { synthesize, verifyCompletion } })
  const abort = signal()
  expect(await host.call('speech', 'tts.synthesize', {}, noop, abort)).toEqual({ completed: true })
  expect(synthesize).toHaveBeenCalledExactlyOnceWith(abort)
  binding.adapter.verifyCompletion(
    { v: 11, instanceId: 'test', type: 'tts_result', runId: 'run', result: { completed: true } },
    ''
  )
  expect(verifyCompletion).toHaveBeenCalledWith({ completed: true })
  await expect(host.call('speech', 'tts.synthesize', {}, noop, abort)).rejects.toMatchObject({
    code: 'AGENT_PROTOCOL_ERROR'
  })
  expect(synthesize).toHaveBeenCalledOnce()
})

it('rejects a nonempty synthesis request before invoking the host', async () => {
  const synthesize = vi.fn()
  const { host } = boundHost({ task: 'tts', host: { synthesize, verifyCompletion: noop } })
  await expect(
    host.call('speech', 'tts.synthesize', { query: 'unbound' }, noop, signal())
  ).rejects.toMatchObject({ code: 'AGENT_PROTOCOL_ERROR' })
  expect(synthesize).not.toHaveBeenCalled()
})

it('does not release a synthesis receipt after cancellation', async () => {
  const abort = new AbortController()
  const synthesize = vi.fn(async () => {
    abort.abort()
    return { completed: true as const }
  })
  const { host } = boundHost({ task: 'tts', host: { synthesize, verifyCompletion: noop } })
  await expect(host.call('speech', 'tts.synthesize', {}, noop, abort.signal)).rejects.toMatchObject(
    { name: 'AbortError' }
  )
  expect(synthesize).toHaveBeenCalledOnce()
})
