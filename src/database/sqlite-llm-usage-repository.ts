import type Database from 'better-sqlite3'
import {
  LlmUsageStatisticsError,
  type LlmUsageBucketAggregate,
  type LlmUsageBucketWindow,
  type LlmUsageStatisticsStore
} from '../core/llm/llm-usage-statistics'
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

interface AggregateRow {
  requestCount: number
  runningCount: number
  invalidCount: number
  inputTokens: number
  outputTokens: number
  totalTokens: number
  inputUnknownCount: number
  outputUnknownCount: number
  totalUnknownCount: number
}

const DEFAULT_PAGE_LIMIT = 50

// 一次实际 chat.completions.create 调用一行；写入失败由调用方
//（LlmUsageRecorder）按旁路失败策略处理，这里不做静默重试。
export class SqliteLlmUsageRepository implements LlmUsageRepository, LlmUsageStatisticsStore {
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

  // 时间桶聚合：invalid 记录不进入 token 合计与未知计数，单独计数；
  // 指标为 NULL 的非 invalid 记录计入对应未知计数，显式 0 计入合计。
  // 全部聚合值做安全整数检查，溢出抛 OVERFLOW，不悄悄舍入。
  aggregateBuckets(windows: readonly LlmUsageBucketWindow[]): LlmUsageBucketAggregate[] {
    const statement = this.database.prepare(`
      SELECT
        COUNT(*) AS requestCount,
        COALESCE(SUM(status = 'started'), 0) AS runningCount,
        COALESCE(SUM(usage_status = 'invalid'), 0) AS invalidCount,
        COALESCE(SUM(CASE
          WHEN usage_status <> 'invalid' AND input_tokens IS NOT NULL THEN input_tokens
        END), 0) AS inputTokens,
        COALESCE(SUM(CASE
          WHEN usage_status <> 'invalid' AND output_tokens IS NOT NULL THEN output_tokens
        END), 0) AS outputTokens,
        COALESCE(SUM(CASE
          WHEN usage_status <> 'invalid' AND total_tokens IS NOT NULL THEN total_tokens
        END), 0) AS totalTokens,
        COALESCE(SUM(usage_status <> 'invalid' AND input_tokens IS NULL), 0) AS inputUnknownCount,
        COALESCE(SUM(usage_status <> 'invalid' AND output_tokens IS NULL), 0) AS outputUnknownCount,
        COALESCE(SUM(usage_status <> 'invalid' AND total_tokens IS NULL), 0) AS totalUnknownCount
      FROM llm_request_usage
      WHERE started_at >= @startAt AND started_at < @endAt
    `)
    return windows.map((window) => {
      if (window.endAt <= window.startAt) return { ...EMPTY_AGGREGATE }
      const row = statement.get(window) as AggregateRow
      const aggregate: LlmUsageBucketAggregate = {
        requestCount: row.requestCount,
        runningCount: row.runningCount,
        invalidCount: row.invalidCount,
        inputTokens: row.inputTokens,
        outputTokens: row.outputTokens,
        totalTokens: row.totalTokens,
        inputUnknownCount: row.inputUnknownCount,
        outputUnknownCount: row.outputUnknownCount,
        totalUnknownCount: row.totalUnknownCount
      }
      for (const value of Object.values(aggregate)) {
        if (!Number.isSafeInteger(value) || value < 0) {
          throw new LlmUsageStatisticsError('OVERFLOW')
        }
      }
      return aggregate
    })
  }
}

const EMPTY_AGGREGATE: LlmUsageBucketAggregate = {
  requestCount: 0,
  runningCount: 0,
  invalidCount: 0,
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
  inputUnknownCount: 0,
  outputUnknownCount: 0,
  totalUnknownCount: 0
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
