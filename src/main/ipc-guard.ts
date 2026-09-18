import type { IpcMainInvokeEvent, WebContents } from 'electron'
import { BrowserWindow, ipcMain } from 'electron'
import type { ZodIssue } from 'zod'
import { z } from 'zod'

// Main 层唯一的 Renderer → Main 请求注册入口：所有 ipcMain.handle 请求
// 都必须经此注册，统一执行来源检查、输入校验、异常转换和完整结果校验。
// Main → Renderer 的推送事件不经过本注册器；业务模块继续自行管理活动
// 请求与生命周期清理。

// 无参数入口的显式输入契约：handler 不接受任何载荷。
export const noInputSchema = z.undefined()

// 可信页面配置：由 Main 装配且必须有效；配置缺失或非法时拒绝创建注册器，
// 不存在默认放行的路径。
export interface TrustedRendererConfig {
  rendererUrl: string
}

// 业务回调可访问的 Main 内部调用上下文：取消与请求归属需要 sender，
// 但来源校验由注册器先行完成，业务回调不承担来源检查。
export interface TrustedHandlerContext {
  sender: WebContents
}

// 从结果联合中提取错误分支的 error 类型，约束错误映射与结果协议兼容。
export type TrustedResultError<TResult> = TResult extends { status: 'error'; error: infer TError }
  ? TError
  : never

export interface TrustedHandlerConfig<
  TInputSchema extends z.ZodType,
  TResultSchema extends z.ZodType
> {
  channel: string
  inputSchema: TInputSchema
  resultSchema: TResultSchema
  invalidInputError: (issues: readonly ZodIssue[]) => TrustedResultError<z.output<TResultSchema>>
  mapError: (error: unknown) => TrustedResultError<z.output<TResultSchema>>
  fallbackError: TrustedResultError<z.output<TResultSchema>>
  handler: (
    input: z.output<TInputSchema>,
    context: TrustedHandlerContext
  ) => z.output<TResultSchema> | Promise<z.output<TResultSchema>>
}

export type RegisterTrustedHandler = <
  TInputSchema extends z.ZodType,
  TResultSchema extends z.ZodType
>(
  config: TrustedHandlerConfig<TInputSchema, TResultSchema>
) => () => void

// 守卫诊断：来源拒绝、输入校验失败、handler 异常、错误映射异常与结果
// 校验失败在转换为安全返回之前上报原始原因，由公共错误日志落盘。
export type IpcGuardOperation =
  'untrusted-source' | 'invalid-input' | 'handler' | 'map-error' | 'result-validation'

export interface IpcGuardDiagnostic {
  level: 'error' | 'warn'
  operation: IpcGuardOperation
  message: string
  error?: unknown
  context?: {
    channel: string
    issues?: Array<{ path: PropertyKey[]; code: string }>
  }
}

export interface IpcGuardDiagnostics {
  report(diagnostic: IpcGuardDiagnostic): void
}

// 只保留 issue 的 path 与 code：message 可能回显用户输入值。
const safeIssues = (issues: readonly ZodIssue[]): Array<{ path: PropertyKey[]; code: string }> =>
  issues.map((issue) => ({ path: issue.path, code: issue.code }))

export function createTrustedHandlerRegistrar(
  trusted: TrustedRendererConfig,
  diagnostics?: IpcGuardDiagnostics
): RegisterTrustedHandler {
  const rendererUrl = parseTrustedRendererUrl(trusted.rendererUrl)
  // 诊断通道自身故障不能影响请求结果；也不递归进入错误日志。
  const report = (diagnostic: IpcGuardDiagnostic): void => {
    try {
      diagnostics?.report(diagnostic)
    } catch {
      // 诊断失败即丢弃。
    }
  }

  return (config) => {
    const { channel, inputSchema, resultSchema, invalidInputError, mapError, fallbackError } =
      config

    // 注册期校验守卫自身产生的两类固定失败结果；协议不兼容时阻止注册，
    // 避免运行时兜底结果再次校验失败。
    const untrustedResult = registerFixedResult(channel, resultSchema, {
      status: 'error',
      error: { code: 'UNTRUSTED_SOURCE' }
    })
    const fallbackResult = registerFixedResult(channel, resultSchema, {
      status: 'error',
      error: fallbackError
    })

    // 动态错误映射的返回值仍按协议校验；映射自身抛错或返回非法结构时
    // 使用已验证的兜底结果，不再递归调用错误映射。
    const errorResultFrom = (produceError: () => unknown): z.output<typeof resultSchema> => {
      try {
        const candidate = resultSchema.safeParse({ status: 'error', error: produceError() })
        if (candidate.success) return candidate.data
        report({
          level: 'error',
          operation: 'map-error',
          message: `error mapping produced a result outside the ${channel} protocol`,
          context: { channel }
        })
        return fallbackResult
      } catch (error) {
        report({
          level: 'error',
          operation: 'map-error',
          message: `error mapping threw while converting a handler error on ${channel}`,
          error,
          context: { channel }
        })
        return fallbackResult
      }
    }

    const finalize = (rawResult: unknown): z.output<typeof resultSchema> => {
      // 成功与失败结果都经完整校验；不符合协议时返回固定兜底，不把
      // 结果校验失败误映射为用户输入错误，也不暴露原始结果。
      const candidate = resultSchema.safeParse(rawResult)
      if (candidate.success) return candidate.data
      report({
        level: 'error',
        operation: 'result-validation',
        message: `handler result on ${channel} failed schema validation; fixed fallback returned`,
        context: { channel, issues: safeIssues(candidate.error.issues) }
      })
      return fallbackResult
    }

    const wrappedHandler = (
      event: IpcMainInvokeEvent,
      rawInput: unknown
    ): z.output<typeof resultSchema> | Promise<z.output<typeof resultSchema>> => {
      // 执行顺序：来源检查 → 输入 safeParse → 调用 handler → 结果校验。
      // 来源检查必须先于输入解析和服务调用。
      if (!isTrustedSource(event, rendererUrl)) {
        // 拒绝请求只记录安全元信息（channel），不含载荷内容。
        report({
          level: 'warn',
          operation: 'untrusted-source',
          message: `request on ${channel} rejected from an untrusted source`,
          context: { channel }
        })
        return untrustedResult
      }
      const parsedInput = inputSchema.safeParse(rawInput)
      if (!parsedInput.success) {
        report({
          level: 'warn',
          operation: 'invalid-input',
          message: `request on ${channel} rejected by input validation`,
          context: { channel, issues: safeIssues(parsedInput.error.issues) }
        })
        return errorResultFrom(() => invalidInputError(parsedInput.error.issues))
      }
      const handleFailure = (error: unknown): z.output<typeof resultSchema> => {
        // 在错误映射折叠信息之前记录原始异常。
        report({
          level: 'error',
          operation: 'handler',
          message: `handler on ${channel} threw`,
          error,
          context: { channel }
        })
        return errorResultFrom(() => mapError(error))
      }
      try {
        const outcome = config.handler(parsedInput.data, { sender: event.sender })
        // 同步结果保持同步返回；同时捕获同步 throw 与 Promise rejection。
        return outcome instanceof Promise
          ? outcome.then(finalize, handleFailure)
          : finalize(outcome)
      } catch (error) {
        return handleFailure(error)
      }
    }

    ipcMain.handle(channel, wrappedHandler)
    return () => ipcMain.removeHandler(channel)
  }
}

function registerFixedResult<TResultSchema extends z.ZodType>(
  channel: string,
  resultSchema: TResultSchema,
  candidate: unknown
): z.output<TResultSchema> {
  const parsed = resultSchema.safeParse(candidate)
  if (!parsed.success) {
    throw new Error(`ipc guard: channel ${channel} 的结果协议不接受守卫固定失败结果`)
  }
  return parsed.data
}

// 只允许本应用窗口当前加载的可信主文档；sender 销毁、非应用窗口、
// 缺失 frame、子 frame 与 URL 不匹配均拒绝。
function isTrustedSource(event: IpcMainInvokeEvent, rendererUrl: string): boolean {
  return (
    !event.sender.isDestroyed() &&
    BrowserWindow.fromWebContents(event.sender)?.webContents === event.sender &&
    event.senderFrame != null &&
    event.senderFrame === event.sender.mainFrame &&
    event.senderFrame.url === rendererUrl
  )
}

function parseTrustedRendererUrl(rawUrl: string): string {
  if (typeof rawUrl !== 'string' || rawUrl.length === 0) {
    throw new Error('ipc guard: 可信 Renderer URL 配置缺失')
  }
  if (!URL.canParse(rawUrl)) {
    throw new Error('ipc guard: 可信 Renderer URL 配置不是合法 URL')
  }
  return rawUrl
}
