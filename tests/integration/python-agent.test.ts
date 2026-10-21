import { describe, expect, it, vi } from 'vitest'
import { resolve } from 'node:path'
import { PythonAgentProcess } from '../../src/main/agent/python-agent-process'
import { PythonAgentRuntime } from '../../src/main/agent/python-agent-runtime'
import type { LanguageModel } from '../../src/core/llm/language-model'
import { ConversationModule } from '../../src/core/conversation/conversation-module'
import { openDatabase } from '../../src/database/database'
import { SqliteConversationRepository } from '../../src/database/sqlite-conversation-repository'
import type { ConversationEvent } from '../../src/shared/conversation'
import { randomUUID } from 'node:crypto'

const launch = (): PythonAgentProcess =>
  new PythonAgentProcess({
    command: resolve(
      'agent-engine/.venv',
      process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python'
    ),
    args: ['-I', '-m', 'lingo_agent']
  })
const model: LanguageModel = {
  async *streamReply() {
    yield { type: 'reasoning', delta: 'temporary' }
    yield { type: 'text', delta: '你好' }
    yield { type: 'text', delta: ' world' }
  }
}

describe('Python LangGraph process', () => {
  it.each(['Hello', '/concept carry', ' /concept\u3000carry ', '/conceptual drift'])(
    'runs %s through Python-owned instructions and canonical conversation persistence',
    async (text) => {
      const database = openDatabase(':memory:')
      const repository = new SqliteConversationRepository(database)
      const seen: import('../../src/core/llm/language-model').StreamReplyInput[] = []
      const runtime = new PythonAgentRuntime(launch(), () => ({
        async *streamReply(input) {
          seen.push(input)
          yield { type: 'reasoning', delta: 'temporary' }
          yield { type: 'text', delta: 'Python reply' }
        }
      }))
      const legacyModel = {
        streamReply: vi.fn(() => {
          throw new Error('TS reply path used')
        })
      }
      const module = new ConversationModule(legacyModel, repository, runtime)
      try {
        const sessionId = randomUUID()
        const now = new Date().toISOString()
        await repository.create({
          id: sessionId,
          title: 'Existing',
          createdAt: now,
          updatedAt: now
        })
        const events: ConversationEvent[] = []
        const accepted = await module.sendMessage(
          { sessionId, requestId: randomUUID(), text },
          (event) => events.push(event)
        )
        await vi.waitFor(() =>
          expect(events.some((event) => event.type === 'completed')).toBe(true)
        )
        expect(seen).toHaveLength(1)
        expect(seen[0].systemPrompt).toContain(
          text.includes('carry') ? 'the /concept command' : 'You are Lingo Mate'
        )
        expect(seen[0].systemPrompt).toContain('Simplified Chinese (zh-CN)')
        expect(seen[0].systemPrompt).toContain('English (en)')
        expect(seen[0].messages).toEqual([{ role: 'user', content: text }])
        expect(legacyModel.streamReply).not.toHaveBeenCalled()
        expect(
          events.filter((event) => ['completed', 'failed', 'cancelled'].includes(event.type))
        ).toHaveLength(1)
        const stored = await repository.history(sessionId)
        expect(stored.map(({ role, content }) => [role, content])).toEqual([
          ['user', text],
          ['assistant', 'Python reply']
        ])
        expect(stored[1].id).toBe(accepted.generation.assistantMessageId)
      } finally {
        await module.shutdown()
        await runtime.dispose()
        database.close()
      }
    }
  )
  it('performs a real handshake and returns streamed graph output exactly once', async () => {
    const process = launch()
    const runtime = new PythonAgentRuntime(process, () => model)
    try {
      const events = []
      for await (const event of runtime.stream({
        sessionId: 'session-1',
        task: 'conversation',
        messages: [{ role: 'user', content: 'Hi' }],
        outputLanguage: 'zh-CN',
        targetLanguage: 'en',
        signal: new AbortController().signal
      }))
        events.push(event)
      expect(events).toEqual([
        { type: 'reasoning', delta: 'temporary' },
        { type: 'text', delta: '你好' },
        { type: 'text', delta: ' world' }
      ])
      expect(process.status).toBe('ready')
      expect(process.handshakes).toBe(1)
    } finally {
      await runtime.dispose()
    }
    expect(process.status).toBe('closed')
  })
  it('completes model → read-only tool → model over the duplex pipe', async () => {
    const process = launch()
    let decisions = 0
    const runtime = new PythonAgentRuntime(process, () => model, {
      async decide({ results, outputLanguage, targetLanguage }) {
        expect([outputLanguage, targetLanguage]).toEqual(['zh-CN', 'en'])
        if (++decisions === 1) return { kind: 'tool', name: 'learning.lookup', query: 'carry' }
        expect(results).toEqual([{ entries: ['carry: transport'] }])
        return { kind: 'final', text: 'explained' }
      },
      async lookup(query) {
        expect(query).toBe('carry')
        return { entries: ['carry: transport'] }
      }
    })
    try {
      const chunks = []
      for await (const e of runtime.stream({
        sessionId: 'tool-session',
        task: 'tool-loop',
        messages: [{ role: 'user', content: 'carry' }],
        outputLanguage: 'zh-CN',
        targetLanguage: 'en',
        signal: new AbortController().signal
      }))
        chunks.push(e)
      expect(chunks).toEqual([{ type: 'text', delta: 'explained' }])
      expect(decisions).toBe(2)
    } finally {
      await runtime.dispose()
    }
  })

  it('cancels one waiting model while another session completes on the same process', async () => {
    const process = launch()
    let started!: () => void
    const waiting = new Promise<void>((r) => {
      started = r
    })
    const blocking: LanguageModel = {
      async *streamReply({ messages, signal }) {
        if (messages[0].content === 'wait') {
          started()
          await new Promise<void>((_, reject) =>
            signal.addEventListener('abort', () => reject(signal.reason), { once: true })
          )
        }
        yield { type: 'text', delta: 'done' }
      }
    }
    const runtime = new PythonAgentRuntime(process, () => blocking)
    const abort = new AbortController()
    const task = (
      content: string,
      signal = new AbortController().signal
    ): import('../../src/core/agent/agent-runtime').AgentRunInput => ({
      sessionId: content,
      task: 'conversation' as const,
      messages: [{ role: 'user' as const, content }],
      outputLanguage: 'en',
      targetLanguage: 'en',
      signal
    })
    const collect = async (
      input: ReturnType<typeof task>
    ): Promise<import('../../src/core/llm/language-model').ModelStreamEvent[]> => {
      const events = []
      for await (const e of runtime.stream(input)) events.push(e)
      return events
    }
    try {
      const pending = collect(task('wait', abort.signal))
      const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
      await waiting
      expect(await collect(task('fast'))).toEqual([{ type: 'text', delta: 'done' }])
      abort.abort()
      await rejected
      expect(await collect(task('next'))).toEqual([{ type: 'text', delta: 'done' }])
      expect(process.handshakes).toBe(1)
    } finally {
      await runtime.dispose()
    }
  })

  it('fails in-flight work on a real crash and restarts for a later new request without replay', async () => {
    const process = launch()
    let attempts = 0
    const stalled: LanguageModel = {
      async *streamReply({ signal }) {
        yield { type: 'reasoning', delta: 'temporary' }
        await new Promise<void>((_, reject) =>
          signal.addEventListener('abort', () => reject(signal.reason), { once: true })
        )
      }
    }
    const runtime = new PythonAgentRuntime(process, () => (++attempts === 1 ? stalled : model))
    const task = {
      sessionId: 'crash',
      task: 'conversation' as const,
      messages: [{ role: 'user' as const, content: 'Hi' }],
      outputLanguage: 'en',
      targetLanguage: 'en',
      signal: new AbortController().signal
    }
    try {
      const stream = runtime.stream(task)[Symbol.asyncIterator]()
      expect((await stream.next()).value).toEqual({ type: 'reasoning', delta: 'temporary' })
      expect(process.pid).toBeGreaterThan(0)
      globalThis.process.kill(process.pid!, 'SIGKILL')
      await new Promise((r) => setTimeout(r, 50))
      await expect(stream.next()).rejects.toMatchObject({ code: 'AGENT_UNAVAILABLE' })
      const events = []
      for await (const event of runtime.stream(task)) events.push(event)
      expect(events).toHaveLength(3)
      expect(process.handshakes).toBe(2)
    } finally {
      await runtime.dispose()
    }
  })
  it('keeps cancel behind its own queued run while releasing the caller immediately', async () => {
    const process = launch()
    const runtime = new PythonAgentRuntime(process, () => model)
    const original = process.send.bind(process)
    let queued!: () => void
    let release!: () => void
    const queuedRun = new Promise<void>((resolve) => {
      queued = resolve
    })
    const blocked = new Promise<void>((resolve) => {
      release = resolve
    })
    const sent: string[] = []
    vi.spyOn(process, 'send').mockImplementation(async (frame, control) => {
      sent.push(frame.type)
      if (frame.type === 'run') {
        queued()
        await blocked
      }
      await original(frame, control)
    })
    const abort = new AbortController()
    const stream = runtime
      .stream({
        sessionId: 'queued',
        task: 'conversation',
        messages: [{ role: 'user', content: 'queued' }],
        outputLanguage: 'en',
        targetLanguage: 'en',
        signal: abort.signal
      })
      [Symbol.asyncIterator]()
    const next = stream.next()
    const rejected = expect(next).rejects.toMatchObject({ name: 'AbortError' })
    try {
      await queuedRun
      abort.abort()
      expect(sent).toEqual(['run'])
      release()
      await rejected
      await new Promise((r) => setTimeout(r, 20))
      expect(process.status).toBe('ready')
    } finally {
      release()
      await rejected
      await runtime.dispose()
    }
  })

  it.each(['wrong-version', 'wrong-instance', 'truncated', 'unknown-run', 'duplicate-call'])(
    'rejects a broken or forged %s child protocol',
    async (mode) => {
      const child = new PythonAgentProcess({
        command: resolve(
          'agent-engine/.venv',
          process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python'
        ),
        args: ['-I', resolve('tests/integration/fixtures/agent/fault-engine.py'), mode]
      })
      const runtime = new PythonAgentRuntime(child, () => model)
      try {
        const stream = runtime.stream({
          sessionId: 'secure',
          task: 'conversation',
          messages: [{ role: 'user', content: 'Hello' }],
          outputLanguage: 'en',
          targetLanguage: 'en',
          signal: new AbortController().signal
        })
        await expect(
          (async () => {
            for await (const e of stream) void e
          })()
        ).rejects.toMatchObject({ code: 'AGENT_PROTOCOL_ERROR' })
      } finally {
        await runtime.dispose()
      }
    }
  )

  it('bounds failed startup attempts and lets a caller cancel before ready', async () => {
    const child = new PythonAgentProcess({
      command: resolve(
        'agent-engine/.venv',
        process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python'
      ),
      args: ['-I', '-c', 'import time; time.sleep(60)'],
      readyTimeoutMs: 50
    })
    const runtime = new PythonAgentRuntime(child, () => model)
    const abort = new AbortController()
    const pending = runtime
      .stream({
        sessionId: 'startup',
        task: 'conversation',
        messages: [{ role: 'user', content: 'Hi' }],
        outputLanguage: 'en',
        targetLanguage: 'en',
        signal: abort.signal
      })
      [Symbol.asyncIterator]()
      .next()
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    abort.abort()
    try {
      await rejected
      await expect(child.start()).rejects.toMatchObject({ code: 'AGENT_UNAVAILABLE' })
      for (let attempt = 0; attempt < 3; attempt++)
        await expect(child.start()).rejects.toMatchObject({ code: 'AGENT_UNAVAILABLE' })
      expect(child.handshakes).toBe(0)
    } finally {
      await runtime.dispose()
    }
  })
  it('terminates an unresponsive shared process after cancellation grace and permits a new handshake', async () => {
    const child = new PythonAgentProcess({
      command: resolve(
        'agent-engine/.venv',
        process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python'
      ),
      args: ['-I', resolve('tests/integration/fixtures/agent/fault-engine.py'), 'ignore-cancel']
    })
    const runtime = new PythonAgentRuntime(child, () => model)
    const abort = new AbortController()
    let sent!: () => void
    const started = new Promise<void>((resolve) => {
      sent = resolve
    })
    const original = child.send.bind(child)
    vi.spyOn(child, 'send').mockImplementation(async (frame, control) => {
      await original(frame, control)
      if (frame.type === 'run') sent()
    })
    const next = runtime
      .stream({
        sessionId: 'hung',
        task: 'conversation',
        messages: [{ role: 'user', content: 'Hi' }],
        outputLanguage: 'en',
        targetLanguage: 'en',
        signal: abort.signal
      })
      [Symbol.asyncIterator]()
      .next()
    const rejected = expect(next).rejects.toMatchObject({ name: 'AbortError' })
    try {
      await started
      abort.abort()
      await rejected
      await expect.poll(() => child.status, { timeout: 1800 }).toBe('failed')
      await child.start()
      expect(child.handshakes).toBe(2)
    } finally {
      await runtime.dispose()
    }
  })
})
