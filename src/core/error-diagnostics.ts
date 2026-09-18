// Core 层的错误诊断出口：不依赖 Electron、文件系统或控制台，由 Main
// 在装配时注入公共错误日志适配器；默认实现丢弃诊断，保证 Core 可独立测试。

export type CoreDiagnosticLevel = 'error' | 'warn'

export interface CoreDiagnosticEntry {
  level?: CoreDiagnosticLevel
  module: string
  operation: string
  requestId?: string
  code?: string
  message: string
  error?: unknown
  context?: unknown
}

export interface CoreDiagnostics {
  report(entry: CoreDiagnosticEntry): void
}

export const noopCoreDiagnostics: CoreDiagnostics = {
  report: () => {}
}
