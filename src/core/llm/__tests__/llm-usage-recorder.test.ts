import { afterEach, describe, expect, it, vi } from 'vitest'
import type { LlmUsageRepository, LlmUsageStart, LlmUsageTerminal } from '../llm-usage'
import { LlmUsageRecorder } from '../llm-usage-recorder'

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

afterEach(() => vi.restoreAllMocks())

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
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const repo = repository()
    repo.insertStarted = () => {
      throw new Error('disk unavailable')
    }
    const recording = new LlmUsageRecorder(repo).begin('vocabulary_analysis', 'test-model')
    // 开始写入失败：通过固定诊断码报告，请求继续。
    expect(consoleError).toHaveBeenCalledWith('[llm-usage] LLM_USAGE_INSERT_FAILED')
    expect(recording).toBeDefined()

    recording.finish(TERMINAL)
    expect(repo.finished).toHaveLength(1)
    expect(consoleError).toHaveBeenCalledTimes(1)
  })

  it('reports finish failures with a diagnostic code instead of throwing', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const repo = repository()
    repo.finish = () => {
      throw new Error('database closed')
    }
    const recording = new LlmUsageRecorder(repo).begin('conversation', 'test-model')
    expect(() => recording.finish(TERMINAL)).not.toThrow()
    expect(consoleError).toHaveBeenCalledWith('[llm-usage] LLM_USAGE_FINISH_FAILED')
  })

  it('does not log request or response payloads in diagnostics', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const repo = repository()
    repo.insertStarted = () => {
      throw new Error('boom https://provider.example/v1 sk-secret')
    }
    new LlmUsageRecorder(repo).begin('conversation', 'secret-model')
    const logged = String(consoleError.mock.calls[0][0])
    expect(logged).toBe('[llm-usage] LLM_USAGE_INSERT_FAILED')
  })
})
