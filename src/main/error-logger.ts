import { appendFileSync, mkdirSync } from 'node:fs'
import { appendFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { CoreDiagnostics } from '../core/error-diagnostics'
import type { IpcGuardDiagnostics } from './ipc-guard'

// 公共错误日志：Main 是唯一文件写入方，按事件发生时的本地日期把各来源
// 错误以 JSONL 追加到 <userData>/logs/YYYY-MM-DD.log。序列化统一脱敏并
// 限制深度与体积；写入串行排队，自身失败只输出固定诊断码，不回退把
// 原始日志打印到控制台，也不影响业务结果。

export type ErrorLogLevel = 'error' | 'warn'
export type ErrorLogSource = 'main' | 'core' | 'preload' | 'renderer'

export interface ErrorLogEntry {
  level?: ErrorLogLevel
  source: ErrorLogSource
  module?: string
  operation?: string
  code?: string
  message: string
  error?: unknown
  context?: unknown
  requestId?: string
}

export interface ErrorLogger {
  /** 追加一条错误记录；永不抛出，失败只影响日志自身。 */
  log(entry: ErrorLogEntry): void
  /** 致命路径的尽力同步写入；用于进程即将终止前的 uncaughtException。 */
  logSync(entry: ErrorLogEntry): void
  /** 登记已知密钥；之后所有文本中的该值都会被替换。只增不减，覆盖在途请求换下的旧密钥。 */
  registerSecret(secret: string): void
  /** 有界等待队列写完；超时也 resolve，不阻塞退出。 */
  flush(timeoutMs?: number): Promise<void>
  readonly directory: string
}

export interface ErrorLoggerOptions {
  now?: () => Date
}

// —— 序列化限制：截断必须留下明确标记 ——

const MAX_STRING_LENGTH = 4000
// 深度需容纳模型响应形状（context → response → choices → message → content）。
const MAX_OBJECT_DEPTH = 6
const MAX_CAUSE_DEPTH = 4
const MAX_AGGREGATE_ERRORS = 8
const MAX_ARRAY_ITEMS = 32
const MAX_ENTRY_BYTES = 64 * 1024

const LOG_DIRECTORY_MODE = 0o700
const LOG_FILE_MODE = 0o600

// 自身失败诊断的输出限频窗口。
const SELF_FAILURE_WINDOW_MS = 60_000

// 覆盖常见凭据字段名；全词匹配，避免误伤 totalTokens 一类计数字段。
const SENSITIVE_KEY_PATTERN =
  /^(?:headers|authorization|proxy-authorization|api[_-]?key|apikey|access[_-]?token|refresh[_-]?token|id[_-]?token|session[_-]?token|cookie|set-cookie|password|client[_-]?secret|secret|token|credential|credentials)$/i

const BEARER_PATTERN = /Bearer\s+[A-Za-z0-9\-._~+/]+=*/g
const URL_CREDENTIALS_PATTERN = /(:\/\/)[^/\s:@]+:[^/\s@]+(@)/g

const REDACTED = '[REDACTED]'

export function createErrorLogger(
  directory: string,
  options: ErrorLoggerOptions = {}
): ErrorLogger {
  const now = options.now ?? (() => new Date())
  // 密钥按长度降序替换，避免前缀短的密钥截断长的替换。
  const secrets: string[] = []
  let lastSelfFailureAt = 0

  const reportSelfFailure = (code: string): void => {
    const at = now().getTime()
    if (at - lastSelfFailureAt < SELF_FAILURE_WINDOW_MS) return
    lastSelfFailureAt = at
    // 仅输出固定诊断码，不含任何原始数据，且不递归进入日志服务。
    console.error(`[error-logger] ${code}`)
  }

  const ensureDirectory = (): void => {
    try {
      mkdirSync(directory, { recursive: true, mode: LOG_DIRECTORY_MODE })
    } catch {
      reportSelfFailure('INIT_FAILED')
    }
  }
  ensureDirectory()

  const truncate = (value: string): string =>
    value.length > MAX_STRING_LENGTH
      ? `${value.slice(0, MAX_STRING_LENGTH)}[Truncated ${value.length - MAX_STRING_LENGTH} chars]`
      : value

  const sanitizeText = (value: string): string => {
    let text = value
    for (const secret of secrets) {
      if (text.includes(secret)) text = text.split(secret).join(REDACTED)
    }
    // 正则带 /g 时 test 有状态（lastIndex），统一走无条件 replace 避免漏替换。
    text = text.replace(BEARER_PATTERN, `Bearer ${REDACTED}`)
    text = text.replace(URL_CREDENTIALS_PATTERN, `$1${REDACTED}$2`)
    return truncate(text)
  }

  const sanitizeValue = (value: unknown, depth: number, seen: Set<object>): unknown => {
    if (typeof value === 'string') return sanitizeText(value)
    if (
      value === null ||
      value === undefined ||
      typeof value === 'number' ||
      typeof value === 'boolean' ||
      typeof value === 'bigint'
    ) {
      return value
    }
    if (typeof value === 'function' || typeof value === 'symbol') return '[Unserializable]'
    if (value instanceof Error) return serializeError(value, 0, seen)
    if (value instanceof Date) return value.toISOString()
    if (value instanceof Map) {
      if (seen.has(value)) return '[Circular]'
      if (depth >= MAX_OBJECT_DEPTH) return '[MaxDepth]'
      seen.add(value)
      const entries = [...value.entries()]
        .slice(0, MAX_ARRAY_ITEMS)
        .map(([key, item]) => [
          sanitizeValue(key, depth + 1, seen),
          sanitizeValue(item, depth + 1, seen)
        ])
      seen.delete(value)
      return { '[Map]': entries }
    }
    if (value instanceof Set) {
      if (seen.has(value)) return '[Circular]'
      if (depth >= MAX_OBJECT_DEPTH) return '[MaxDepth]'
      seen.add(value)
      const items = [...value.values()]
        .slice(0, MAX_ARRAY_ITEMS)
        .map((item) => sanitizeValue(item, depth + 1, seen))
      seen.delete(value)
      return { '[Set]': items }
    }
    if (Array.isArray(value)) {
      if (seen.has(value)) return '[Circular]'
      if (depth >= MAX_OBJECT_DEPTH) return '[MaxDepth]'
      seen.add(value)
      const items = value
        .slice(0, MAX_ARRAY_ITEMS)
        .map((item) => sanitizeValue(item, depth + 1, seen))
      const omitted = value.length - items.length
      seen.delete(value)
      return omitted > 0 ? [...items, `[Truncated: ${omitted} more items]`] : items
    }
    // 普通对象与类实例：按字段脱敏后保留，供排查配置/响应类上下文。
    if (seen.has(value)) return '[Circular]'
    if (depth >= MAX_OBJECT_DEPTH) return '[MaxDepth]'
    seen.add(value)
    const sanitized: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value)) {
      sanitized[sanitizeText(key)] = SENSITIVE_KEY_PATTERN.test(key)
        ? REDACTED
        : sanitizeValue(item, depth + 1, seen)
    }
    seen.delete(value)
    return sanitized
  }

  const serializeError = (error: Error, depth: number, seen: Set<object>): unknown => {
    if (seen.has(error)) return '[Circular]'
    seen.add(error)
    const serialized: Record<string, unknown> = {
      name: sanitizeText(error.name),
      message: sanitizeText(error.message)
    }
    if (typeof error.stack === 'string') serialized['stack'] = sanitizeText(error.stack)
    for (const [key, item] of Object.entries(error)) {
      if (key === 'cause' || key === 'errors' || key === 'message' || key === 'stack') continue
      serialized[sanitizeText(key)] = SENSITIVE_KEY_PATTERN.test(key)
        ? REDACTED
        : sanitizeValue(item, depth, seen)
    }
    if (error instanceof AggregateError) {
      serialized['errors'] = error.errors
        .slice(0, MAX_AGGREGATE_ERRORS)
        .map((item) =>
          item instanceof Error
            ? serializeError(item, depth + 1, seen)
            : sanitizeValue(item, depth + 1, seen)
        )
    }
    if (depth < MAX_CAUSE_DEPTH && error.cause !== undefined && error.cause !== null) {
      serialized['cause'] =
        error.cause instanceof Error
          ? serializeError(error.cause, depth + 1, seen)
          : sanitizeValue(error.cause, depth + 1, seen)
    } else if (error.cause !== undefined && error.cause !== null) {
      serialized['cause'] = '[MaxDepth]'
    }
    seen.delete(error)
    return serialized
  }

  const formatLocalDate = (at: Date): string =>
    `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, '0')}-${String(at.getDate()).padStart(2, '0')}`

  // 与文件日期同一口径（本地时间）的带时区时间戳。
  const formatLocalTimestamp = (at: Date): string => {
    const offsetMinutes = -at.getTimezoneOffset()
    const sign = offsetMinutes >= 0 ? '+' : '-'
    const absOffset = Math.abs(offsetMinutes)
    const hh = String(Math.floor(absOffset / 60)).padStart(2, '0')
    const mm = String(absOffset % 60).padStart(2, '0')
    return `${formatLocalDate(at)}T${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}:${String(at.getSeconds()).padStart(2, '0')}.${String(at.getMilliseconds()).padStart(3, '0')}${sign}${hh}:${mm}`
  }

  const serializeEntry = (entry: ErrorLogEntry, at: Date): string => {
    const seen = new Set<object>()
    const record: Record<string, unknown> = {
      timestamp: formatLocalTimestamp(at),
      level: entry.level ?? 'error',
      source: entry.source
    }
    if (entry.module !== undefined) record['module'] = sanitizeText(entry.module)
    if (entry.operation !== undefined) record['operation'] = sanitizeText(entry.operation)
    if (entry.code !== undefined) record['code'] = sanitizeText(entry.code)
    record['message'] = sanitizeText(entry.message)
    if (entry.error !== undefined) {
      record['error'] =
        entry.error instanceof Error
          ? serializeError(entry.error, 0, seen)
          : sanitizeValue(entry.error, 0, seen)
    }
    if (entry.context !== undefined) record['context'] = sanitizeValue(entry.context, 0, seen)
    if (entry.requestId !== undefined) record['requestId'] = sanitizeText(entry.requestId)

    // 超过单条上限时按明确降级顺序收缩：先丢 context，再收缩 error，
    // 每步都留下 truncated 标记。
    let line = JSON.stringify(record)
    if (Buffer.byteLength(line, 'utf8') > MAX_ENTRY_BYTES) {
      record['context'] = { truncated: true }
      record['truncated'] = true
      line = JSON.stringify(record)
    }
    if (Buffer.byteLength(line, 'utf8') > MAX_ENTRY_BYTES) {
      const error = record['error']
      record['error'] =
        error instanceof Object && error !== null && 'name' in error
          ? {
              name: (error as Record<string, unknown>)['name'],
              message: truncate(String((error as Record<string, unknown>)['message'] ?? '')),
              truncated: true
            }
          : '[Truncated]'
      line = JSON.stringify(record)
    }
    return line.endsWith('\n') ? line : `${line}\n`
  }

  const filePathFor = (at: Date): string => join(directory, `${formatLocalDate(at)}.log`)

  const appendLineSync = (path: string, line: string): void => {
    try {
      ensureDirectory()
      appendFileSync(path, line, { encoding: 'utf8', mode: LOG_FILE_MODE })
    } catch {
      reportSelfFailure('WRITE_FAILED')
    }
  }

  // 串行队列：并发 log() 只入队，由单一 drain 循环逐条追加，避免行交错。
  const queue: Array<{ path: string; line: string }> = []
  let draining: Promise<void> | null = null

  const appendLine = async ({ path, line }: { path: string; line: string }): Promise<void> => {
    try {
      await appendFile(path, line, { encoding: 'utf8', mode: LOG_FILE_MODE })
    } catch {
      reportSelfFailure('WRITE_FAILED')
    }
  }

  const drain = async (): Promise<void> => {
    while (queue.length > 0) {
      const batch = queue.splice(0, queue.length)
      for (const line of batch) await appendLine(line)
    }
  }

  const scheduleDrain = (): void => {
    if (draining !== null) return
    draining = drain().finally(() => {
      draining = null
    })
  }

  return {
    directory,
    registerSecret(secret: string): void {
      if (typeof secret !== 'string' || secret.length < 6 || secrets.includes(secret)) return
      secrets.push(secret)
      secrets.sort((a, b) => b.length - a.length)
    },
    log(entry: ErrorLogEntry): void {
      try {
        const at = now()
        queue.push({ path: filePathFor(at), line: serializeEntry(entry, at) })
        scheduleDrain()
      } catch {
        reportSelfFailure('SERIALIZE_FAILED')
      }
    },
    logSync(entry: ErrorLogEntry): void {
      try {
        const at = now()
        appendLineSync(filePathFor(at), serializeEntry(entry, at))
      } catch {
        reportSelfFailure('SERIALIZE_FAILED')
      }
    },
    async flush(timeoutMs = 1500): Promise<void> {
      if (queue.length > 0) scheduleDrain()
      const pending = draining
      if (pending === null) return
      await Promise.race([pending, new Promise((resolve) => setTimeout(resolve, timeoutMs))])
    }
  }
}

// 进程级错误采集的最小结构；真实 process 满足该形状，测试注入替身。
export interface ProcessErrorSink {
  on(event: 'uncaughtException', listener: (error: Error) => void): unknown
  on(event: 'unhandledRejection', listener: (reason: unknown, promise: unknown) => void): unknown
}

const installedLoggers = new WeakSet<object>()

/**
 * 注册 Main 进程级错误监听。uncaughtException 走尽力同步写入并保留
 * 非零退出的正常终止语义（不带着不可靠状态继续运行）；unhandledRejection
 * 只入队记录。同一 logger 重复安装不会叠加监听器。
 */
export function installProcessErrorHandlers(
  logger: ErrorLogger,
  options: { process?: ProcessErrorSink; exit?: (code: number) => void } = {}
): void {
  if (installedLoggers.has(logger)) return
  installedLoggers.add(logger)
  const target = options.process ?? process
  const exit = options.exit ?? ((code: number) => process.exit(code))

  target.on('uncaughtException', (error: Error) => {
    try {
      logger.logSync({
        source: 'main',
        module: 'process',
        operation: 'uncaughtException',
        message: error instanceof Error ? error.message : String(error),
        error
      })
    } finally {
      exit(1)
    }
  })

  target.on('unhandledRejection', (reason: unknown) => {
    logger.log({
      source: 'main',
      module: 'process',
      operation: 'unhandledRejection',
      message: reason instanceof Error ? reason.message : String(reason),
      error: reason
    })
  })
}

// Core 诊断接口的 Main 侧实现：把 Core 上报统一标记为 core 来源。
export function createCoreDiagnostics(logger: ErrorLogger): CoreDiagnostics {
  return {
    report: (entry) => {
      logger.log({
        level: entry.level,
        source: 'core',
        module: entry.module,
        operation: entry.operation,
        requestId: entry.requestId,
        code: entry.code,
        message: entry.message,
        error: entry.error,
        context: entry.context
      })
    }
  }
}

// IPC 守卫诊断的 Main 侧实现：守卫事件统一标记为 main/ipc-guard。
export function createIpcGuardDiagnostics(logger: ErrorLogger): IpcGuardDiagnostics {
  return {
    report: (diagnostic) => {
      logger.log({
        level: diagnostic.level,
        source: 'main',
        module: 'ipc-guard',
        operation: diagnostic.operation,
        code: diagnostic.code,
        message: diagnostic.message,
        error: diagnostic.error,
        context: diagnostic.context
      })
    }
  }
}
