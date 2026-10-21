import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { AGENT_PROTOCOL_VERSION, type AgentFrame } from '../../core/agent/agent-protocol'
import { AgentRuntimeError } from '../../core/agent/agent-runtime'
import { AgentFrameDecoder, AgentFrameWriter } from './agent-transport'

type Payload<T> = T extends AgentFrame ? Omit<T, 'v' | 'instanceId'> : never
export type AgentPayload = Payload<AgentFrame>
export interface PythonAgentLaunch {
  command: string
  args: string[]
  readyTimeoutMs?: number
  onDiagnostic?: (error: Error) => void
}
export function agentEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PYTHONUTF8: '1',
    PYTHONUNBUFFERED: '1',
    LANG: 'en_US.UTF-8',
    LANGCHAIN_TRACING_V2: 'false',
    LANGSMITH_TRACING: 'false',
    LANGSMITH_OTEL_ENABLED: 'false'
  }
  for (const key of ['SystemRoot', 'WINDIR', 'TEMP', 'TMP'])
    if (process.env[key]) env[key] = process.env[key]
  return env
}

export class PythonAgentProcess {
  status: 'idle' | 'starting' | 'ready' | 'failed' | 'closed' = 'idle'
  handshakes = 0
  instanceId = ''
  private child?: ChildProcessWithoutNullStreams
  private writer?: AgentFrameWriter
  private starting?: Promise<void>
  private attempts = 0
  private closed = false
  private breakProcess?: (
    code: 'AGENT_UNAVAILABLE' | 'AGENT_PROTOCOL_ERROR',
    cause?: unknown
  ) => void
  private readonly frames = new Set<(frame: AgentFrame) => void>()
  private readonly failures = new Set<(error: AgentRuntimeError) => void>()
  constructor(private readonly launch: PythonAgentLaunch | (() => PythonAgentLaunch)) {}

  get pid(): number | undefined {
    return this.child?.pid
  }

  subscribe(
    frame: (frame: AgentFrame) => void,
    failure: (error: AgentRuntimeError) => void
  ): () => void {
    this.frames.add(frame)
    this.failures.add(failure)
    return () => {
      this.frames.delete(frame)
      this.failures.delete(failure)
    }
  }
  start(): Promise<void> {
    if (this.closed) return Promise.reject(new AgentRuntimeError('AGENT_UNAVAILABLE'))
    if (this.status === 'ready') return Promise.resolve()
    if (this.starting) return this.starting
    if (++this.attempts > 3) return Promise.reject(new AgentRuntimeError('AGENT_UNAVAILABLE'))
    let launch: PythonAgentLaunch
    try {
      launch = typeof this.launch === 'function' ? this.launch() : this.launch
    } catch (cause) {
      return Promise.reject(new AgentRuntimeError('AGENT_UNAVAILABLE', { cause }))
    }
    this.status = 'starting'
    this.instanceId = randomUUID()
    const instanceId = this.instanceId
    this.starting = new Promise<void>((resolve, reject) => {
      const decoder = new AgentFrameDecoder()
      let stderr = ''
      let settled = false
      const child = spawn(launch.command, launch.args, {
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: agentEnvironment(),
        windowsHide: true
      })
      this.child = child
      const writer = new AgentFrameWriter(child.stdin)
      this.writer = writer
      const fail = (code: 'AGENT_UNAVAILABLE' | 'AGENT_PROTOCOL_ERROR', cause?: unknown): void => {
        if (this.child !== child) return
        const error = new AgentRuntimeError(code, { cause })
        this.status = this.closed ? 'closed' : 'failed'
        writer.close(error)
        child.kill('SIGKILL')
        this.child = undefined
        if (!settled) {
          settled = true
          clearTimeout(timer)
          reject(error)
        }
        try {
          launch.onDiagnostic?.(new Error(code, { cause: stderr ? new Error(stderr) : cause }))
        } catch {
          /* diagnostics cannot prevent cleanup */
        }
        for (const listener of this.failures) listener(error)
      }
      this.breakProcess = fail
      const timer = setTimeout(
        () => fail('AGENT_UNAVAILABLE', new Error('Agent ready timeout')),
        launch.readyTimeoutMs ?? 30_000
      )
      child.on('error', (error) => fail('AGENT_UNAVAILABLE', error))
      child.stdin.on('error', (error) => fail('AGENT_UNAVAILABLE', error))
      child.stderr.on('data', (data: Buffer) => {
        stderr = (stderr + data.toString('utf8')).slice(-8192)
      })
      child.stdout.on('data', (data: Buffer) => {
        if (this.child !== child) return
        try {
          for (const frame of decoder.push(data)) {
            if (this.child !== child) return
            if (frame.instanceId !== instanceId) throw new Error('Agent instance mismatch')
            if (this.status === 'starting') {
              if (
                frame.type !== 'ready' ||
                !(['conversation', 'tool-loop', 'vocabulary'] as const).every((c) =>
                  frame.capabilities.includes(c)
                )
              )
                throw new Error('Agent handshake mismatch')
              this.status = 'ready'
              this.handshakes++
              settled = true
              clearTimeout(timer)
              resolve()
            } else {
              if (frame.type === 'ready') throw new Error('Duplicate agent handshake')
              for (const listener of this.frames) listener(frame)
            }
          }
        } catch (cause) {
          fail('AGENT_PROTOCOL_ERROR', cause)
        }
      })
      child.stdout.on('end', () => {
        try {
          decoder.finish()
        } catch (cause) {
          fail('AGENT_PROTOCOL_ERROR', cause)
          return
        }
        if (!this.closed) fail('AGENT_UNAVAILABLE')
      })
      child.on('exit', () => {
        clearTimeout(timer)
        if (!this.closed || !settled) fail('AGENT_UNAVAILABLE')
      })
      void writer
        .send({ v: AGENT_PROTOCOL_VERSION, instanceId, type: 'hello' })
        .catch((error) => fail('AGENT_UNAVAILABLE', error))
    }).finally(() => {
      this.starting = undefined
    })
    return this.starting
  }
  async send(payload: AgentPayload, control = false): Promise<void> {
    if (this.status !== 'ready' || !this.writer) throw new AgentRuntimeError('AGENT_UNAVAILABLE')
    await this.writer.send(
      { ...payload, v: AGENT_PROTOCOL_VERSION, instanceId: this.instanceId } as AgentFrame,
      control
    )
  }
  invalidate(code: 'AGENT_UNAVAILABLE' | 'AGENT_PROTOCOL_ERROR' = 'AGENT_PROTOCOL_ERROR'): void {
    this.breakProcess?.(code)
  }
  async shutdown(): Promise<void> {
    if (this.closed) return
    const child = this.child
    if (!child) {
      this.closed = true
      this.status = 'closed'
      return
    }
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()))
    if (this.status === 'ready') {
      void this.send({ type: 'shutdown' }, true).catch(() => child.kill('SIGKILL'))
    } else child.kill('SIGKILL')
    this.closed = true
    this.status = 'closed'
    const timer = setTimeout(() => child.kill('SIGKILL'), 1000)
    await exited
    clearTimeout(timer)
    this.writer?.close()
    this.child = undefined
  }
}
