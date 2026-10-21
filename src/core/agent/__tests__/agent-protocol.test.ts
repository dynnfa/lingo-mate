import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { agentFrameSchema, AGENT_PROTOCOL_VERSION } from '../agent-protocol'

describe('agent protocol', () => {
  it('accepts a versioned handshake and rejects incompatible versions and extra authority', () => {
    const frame = { v: AGENT_PROTOCOL_VERSION, instanceId: 'process-1', type: 'hello' }
    expect(agentFrameSchema.parse(frame)).toEqual(frame)
    expect(agentFrameSchema.safeParse({ ...frame, v: 99 }).success).toBe(false)
    expect(agentFrameSchema.safeParse({ ...frame, apiKey: 'secret' }).success).toBe(false)
  })
})

const cases: Array<{ name: string; valid: boolean; frame: unknown }> = JSON.parse(
  readFileSync(resolve('tests/integration/fixtures/agent/protocol-cases.json'), 'utf8')
)
it.each(cases)('$name obeys the shared wire contract', ({ valid, frame }) => {
  expect(agentFrameSchema.safeParse(frame).success).toBe(valid)
})
