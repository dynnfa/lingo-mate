import { randomUUID } from 'node:crypto'
import type {
  LlmRequestOperation,
  LlmRequestStatus,
  LlmUsageRepository,
  LlmUsageStart,
  LlmUsageTerminal,
  ParsedLlmUsage
} from './llm-usage'

// 一次模型调用的记录上下文：每次实际请求独立持有，不维护共享的
// “当前请求”状态。finish 幂等——迟到回调不会重复写或改写终态。
export interface LlmUsageRecording {
  readonly id: string
  finish(terminal: LlmUsageTerminalInput): void
}

export interface LlmUsageTerminalInput {
  status: Extract<LlmRequestStatus, 'completed' | 'failed' | 'cancelled'>
  finishedAt: number
  responseModelId: string | null
  usage: ParsedLlmUsage
  errorCode: string | null
}

// 记账是旁路能力：写入失败通过不含用户数据的固定诊断码报告，
// 不影响模型请求本身，也不静默宣称记账成功。
function reportDiagnostic(code: 'LLM_USAGE_INSERT_FAILED' | 'LLM_USAGE_FINISH_FAILED'): void {
  console.error(`[llm-usage] ${code}`)
}

// 仅供 LlmClient 使用：统一创建调用 ID、写入 started 记录并幂等收尾。
// 业务适配器不注入 recorder、不手动 begin/finish。
export class LlmUsageRecorder {
  constructor(private readonly repository: LlmUsageRepository) {}

  begin(
    operation: LlmRequestOperation,
    modelId: string,
    startedAt: number = Date.now()
  ): LlmUsageRecording {
    const start: LlmUsageStart = { id: randomUUID(), operation, modelId, startedAt }
    try {
      this.repository.insertStarted(start)
    } catch {
      reportDiagnostic('LLM_USAGE_INSERT_FAILED')
    }

    let settled = false
    return {
      id: start.id,
      finish: (terminal) => {
        if (settled) return
        settled = true
        const record: LlmUsageTerminal = {
          ...start,
          finishedAt: terminal.finishedAt,
          status: terminal.status,
          inputTokens: terminal.usage.inputTokens,
          outputTokens: terminal.usage.outputTokens,
          totalTokens: terminal.usage.totalTokens,
          usageStatus: terminal.usage.usageStatus,
          responseModelId: terminal.responseModelId,
          errorCode: terminal.errorCode
        }
        try {
          // 若开始记录未写入，这里按同一 ID 幂等补写完整记录。
          this.repository.finish(record)
        } catch {
          reportDiagnostic('LLM_USAGE_FINISH_FAILED')
        }
      }
    }
  }
}
