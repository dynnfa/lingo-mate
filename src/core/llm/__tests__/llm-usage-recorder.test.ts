import { describe, expect, it } from 'vitest'
import type { LlmUsageRepository, LlmUsageStart, LlmUsageTerminal } from '../llm-usage'
import { LlmUsageRecorder } from '../llm-usage-recorder'
import type { CoreDiagnostics } from '../../error-diagnostics'

function diagnostics(): CoreDiagnostics & { entries: Array<Record<string, unknown>> } {
  const entries: Array<Record<string, unknown>> = []
  return {
    entries,
    report: (entry) => {
      entries.push(entry as unknown as Record<string, unknown>)
    }
  }
}

function repository(): LlmUsageRepository & {
  started: LlmUsageStart[]
  finished: LlmUsageTerminal[]
} {
  const started: LlmUsageStart[] = []
  const finished: LlmUsageTerminal[] = []
  return {
    started,
    finished,
    insertStarted: (record) => {
      started.push(record)
    },
    finish: (record) => {
      finished.push(record)
    },
    markInterruptedStarted: () => 0,
    list: () => []
  }
}

const TERMINAL = {
  status: 'completed' as const,
  finishedAt: 1_000,
  responseModelId: 'provider-model',
  usage: { inputTokens: 3, outputTokens: 4, totalTokens: 7, usageStatus: 'reported' as const },
  errorCode: null
}

describe('LlmUsageRecorder', () => {
  it('inserts a started row on begin and one terminal row on finish', () => {
    const repo = repository()
    const recording = new LlmUsageRecorder(repo).begin('conversation', 'test-model', 500)
    expect(repo.started).toEqual([
      { id: recording.id, operation: 'conversation', modelId: 'test-model', startedAt: 500 }
    ])
    expect(recording.id).toMatch(/^[0-9a-f-]{36}$/)

    recording.finish(TERMINAL)
    expect(repo.finished).toHaveLength(1)
    expect(repo.finished[0]).toMatchObject({
      id: recording.id,
      operation: 'conversation',
      modelId: 'test-model',
      startedAt: 500,
      finishedAt: 1_000,
      status: 'completed',
      inputTokens: 3,
      outputTokens: 4,
      totalTokens: 7,
      usageStatus: 'reported',
      responseModelId: 'provider-model',
      errorCode: null
    })
  })

  it('ignores every finish after the first one', () => {
    const repo = repository()
    const recording = new LlmUsageRecorder(repo).begin('connection_test', 'test-model')
    recording.finish(TERMINAL)
    recording.finish({ ...TERMINAL, status: 'cancelled', errorCode: 'CONSUMER_CLOSED' })
    expect(repo.finished).toHaveLength(1)
    expect(repo.finished[0].status).toBe('completed')
  })

  it('keeps recording the request even when persistence fails', () => {
    const sink = diagnostics()
    const repo = repository()
    repo.insertStarted = () => {
      throw new Error('disk unavailable')
    }
    const recording = new LlmUsageRecorder(repo, sink).begin('vocabulary_analysis', 'test-model')
    // 开始写入失败：通过固定诊断码报告，请求继续。
    expect(sink.entries).toEqual([expect.objectContaining({ code: 'LLM_USAGE_INSERT_FAILED' })])
    expect(recording).toBeDefined()

    recording.finish(TERMINAL)
    expect(repo.finished).toHaveLength(1)
    expect(sink.entries).toHaveLength(1)
  })

  it('reports finish failures with a diagnostic code instead of throwing', () => {
    const sink = diagnostics()
    const repo = repository()
    repo.finish = () => {
      throw new Error('database closed')
    }
    const recording = new LlmUsageRecorder(repo, sink).begin('conversation', 'test-model')
    expect(() => recording.finish(TERMINAL)).not.toThrow()
    expect(sink.entries).toEqual([expect.objectContaining({ code: 'LLM_USAGE_FINISH_FAILED' })])
  })

  it('does not log request or response payloads in diagnostics', () => {
    const sink = diagnostics()
    const repo = repository()
    repo.insertStarted = () => {
      throw new Error('boom https://provider.example/v1 sk-secret')
    }
    new LlmUsageRecorder(repo, sink).begin('conversation', 'secret-model')
    expect(sink.entries).toHaveLength(1)
    expect(sink.entries[0]['code']).toBe('LLM_USAGE_INSERT_FAILED')
    expect(JSON.stringify(sink.entries)).not.toContain('sk-secret')
  })
})
