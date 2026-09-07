import type Database from 'better-sqlite3'
import type {
  LlmUsageQuery,
  LlmUsageRecord,
  LlmUsageRepository,
  LlmUsageStart,
  LlmUsageTerminal
} from '../core/llm/llm-usage'

interface UsageRow {
  id: string
  operation: LlmUsageRecord['operation']
  model_id: string
  response_model_id: string | null
  started_at: number
  finished_at: number | null
  status: LlmUsageRecord['status']
  input_tokens: number | null
  output_tokens: number | null
  total_tokens: number | null
  usage_status: LlmUsageRecord['usageStatus']
  error_code: string | null
}

const DEFAULT_PAGE_LIMIT = 50

// 一次实际 chat.completions.create 调用一行；写入失败由调用方
// （LlmUsageRecorder）按旁路失败策略处理，这里不做静默重试。
export class SqliteLlmUsageRepository implements LlmUsageRepository {
  constructor(private readonly database: Database.Database) {}

  insertStarted(record: LlmUsageStart): void {
    this.database
      .prepare(
        `INSERT INTO llm_request_usage
           (id, operation, model_id, started_at, status, usage_status)
         VALUES (@id, @operation, @modelId, @startedAt, 'started', 'missing')`
      )
      .run(record)
  }

  // 终态更新幂等：只迁移 status = 'started' 的行；若开始记录从未写入
  //（开始写入失败），按同一 ID 补写完整记录。既有终态不被迟到回调改写。
  finish(record: LlmUsageTerminal): void {
    const updated = this.database
      .prepare(
        `UPDATE llm_request_usage SET
           response_model_id = @responseModelId,
           finished_at = @finishedAt,
           status = @status,
           input_tokens = @inputTokens,
           output_tokens = @outputTokens,
           total_tokens = @totalTokens,
           usage_status = @usageStatus,
           error_code = @errorCode
         WHERE id = @id AND status = 'started'`
      )
      .run(record)
    if (updated.changes > 0) return
    this.database
      .prepare(
        `INSERT OR IGNORE INTO llm_request_usage
           (id, operation, model_id, response_model_id, started_at, finished_at, status,
            input_tokens, output_tokens, total_tokens, usage_status, error_code)
         VALUES (@id, @operation, @modelId, @responseModelId, @startedAt, @finishedAt,
                 @status, @inputTokens, @outputTokens, @totalTokens, @usageStatus,
                 @errorCode)`
      )
      .run(record)
  }

  // 遗留 started 的真实结束时间未知：finished_at 保持 NULL，不把恢复时间
  // 冒充结束时间，也不重发请求。
  markInterruptedStarted(): number {
    return this.database
      .prepare(`UPDATE llm_request_usage SET status = 'interrupted' WHERE status = 'started'`)
      .run().changes
  }

  list(query: LlmUsageQuery): LlmUsageRecord[] {
    const conditions: string[] = []
    const params: Record<string, unknown> = {}
    if (query.modelId !== undefined) {
      conditions.push('model_id = @modelId')
      params.modelId = query.modelId
    }
    if (query.fromStartedAt !== undefined) {
      conditions.push('started_at >= @fromStartedAt')
      params.fromStartedAt = query.fromStartedAt
    }
    if (query.toStartedAt !== undefined) {
      conditions.push('started_at <= @toStartedAt')
      params.toStartedAt = query.toStartedAt
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
    const rows = this.database
      .prepare(
        `SELECT * FROM llm_request_usage ${where}
         ORDER BY started_at DESC, id
         LIMIT @limit OFFSET @offset`
      )
      .all({
        ...params,
        limit: query.limit ?? DEFAULT_PAGE_LIMIT,
        offset: query.offset ?? 0
      }) as UsageRow[]
    return rows.map(toRecord)
  }
}

function toRecord(row: UsageRow): LlmUsageRecord {
  return {
    id: row.id,
    operation: row.operation,
    modelId: row.model_id,
    responseModelId: row.response_model_id,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    status: row.status,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    totalTokens: row.total_tokens,
    usageStatus: row.usage_status,
    errorCode: row.error_code
  }
}
