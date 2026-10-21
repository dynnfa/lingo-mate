import type { Writable } from 'node:stream'
import {
  agentFrameSchema,
  MAX_AGENT_FRAME_BYTES,
  type AgentFrame
} from '../../core/agent/agent-protocol'

export class AgentFrameDecoder {
  private buffered = Buffer.alloc(0)
  push(chunk: Buffer): AgentFrame[] {
    const bytes = Buffer.concat([this.buffered, chunk])
    const frames: AgentFrame[] = []
    let offset = 0
    for (;;) {
      const end = bytes.indexOf(10, offset)
      if (end < 0) break
      if (end - offset > MAX_AGENT_FRAME_BYTES) throw new Error('Agent frame limit')
      const line = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(offset, end))
      frames.push(agentFrameSchema.parse(JSON.parse(line)))
      offset = end + 1
    }
    this.buffered = bytes.subarray(offset)
    if (this.buffered.length > MAX_AGENT_FRAME_BYTES) throw new Error('Agent frame limit')
    return frames
  }
  finish(): void {
    if (this.buffered.length) throw new Error('Incomplete agent frame')
  }
}

// Bounded serialized writes; the callback waits for the pipe to consume data.
// A cancellation frame bypasses the ordinary queue, without interleaving bytes.
export class AgentFrameWriter {
  private queue: Array<{ bytes: Buffer; resolve: () => void; reject: (e: Error) => void }> = []
  private pending?: { reject: (e: Error) => void }
  private size = 0
  private writing = false
  private failure?: Error
  constructor(
    private readonly stream: Writable,
    private readonly maxBytes = 1_048_576
  ) {}

  send(frame: AgentFrame, control = false): Promise<void> {
    const bytes = Buffer.from(`${JSON.stringify(agentFrameSchema.parse(frame))}\n`)
    if (bytes.length > MAX_AGENT_FRAME_BYTES + 1 || this.size + bytes.length > this.maxBytes)
      return Promise.reject(new Error('Agent send queue limit'))
    if (this.failure) return Promise.reject(this.failure)
    this.size += bytes.length
    return new Promise((resolve, reject) => {
      const item = { bytes, resolve, reject }
      if (control) this.queue.unshift(item)
      else this.queue.push(item)
      this.drain()
    })
  }
  close(error = new Error('Agent pipe closed')): void {
    this.failure = error
    this.pending?.reject(error)
    this.pending = undefined
    for (const item of this.queue.splice(0)) {
      this.size -= item.bytes.length
      item.reject(error)
    }
  }
  private drain(): void {
    if (this.writing || this.failure) return
    const item = this.queue.shift()
    if (!item) return
    this.writing = true
    this.pending = item
    this.stream.write(item.bytes, (error) => {
      this.pending = undefined
      this.writing = false
      this.size -= item.bytes.length
      if (error) {
        item.reject(error)
        this.close(error)
      } else {
        item.resolve()
        this.drain()
      }
    })
  }
}
