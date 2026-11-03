import { describe, expect, it } from 'vitest'
import { Writable } from 'node:stream'
import { AgentFrameWriter, AgentFrameDecoder } from '../agent-transport'

describe('private agent pipe', () => {
  it('decodes split UTF-8 and coalesced frames without treating a data event as a frame', () => {
    const decoder = new AgentFrameDecoder()
    const bytes = Buffer.from(
      '{"v":12,"instanceId":"中文","type":"hello"}\n{"v":12,"instanceId":"p","type":"shutdown"}\n'
    )
    const cut = bytes.indexOf(Buffer.from('中文')) + 1
    expect(decoder.push(bytes.subarray(0, cut))).toEqual([])
    expect(decoder.push(bytes.subarray(cut))).toEqual([
      { v: 12, instanceId: '中文', type: 'hello' },
      { v: 12, instanceId: 'p', type: 'shutdown' }
    ])
  })
  it('bounds blocked writes and releases the pending sender when the pipe closes', async () => {
    const blocked = new Writable({
      write() {
        /* hold the write callback to simulate a full pipe */
      }
    })
    const writer = new AgentFrameWriter(blocked, 256)
    const pending = writer.send({ v: 12, instanceId: 'p', type: 'hello' })
    const rejected = expect(pending).rejects.toThrow('closed')
    await expect(
      writer.send({ v: 12, instanceId: 'p', runId: 'r', type: 'result', text: 'x'.repeat(300) })
    ).rejects.toThrow('queue limit')
    writer.close()
    await rejected
    blocked.destroy()
  })

  it.each([Buffer.from('{bad}\n'), Buffer.from([255, 10]), Buffer.alloc(262145, 120)])(
    'rejects invalid frames before dispatch',
    (bytes) => {
      expect(() => new AgentFrameDecoder().push(bytes)).toThrow()
    }
  )
})
