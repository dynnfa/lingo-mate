import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { VocabularyAnalysisFailure } from '../core/llm/llm-vocabulary-analyzer'

// 用户明确授权保存 AI 导入失败的模型响应；不记录请求、配置或 SDK 错误对象。
// 独立文件仅由 Main 写入，不转发到 Renderer 或控制台。
export function createAiImportFailureLogger(
  directory: string
): (failure: VocabularyAnalysisFailure, apiKey?: string) => void {
  const path = join(directory, 'ai-import-errors.log')
  return (failure, apiKey) => {
    const line =
      JSON.stringify({ timestamp: new Date().toISOString(), ...failure }, (key, value: unknown) => {
        if (
          /^(?:headers|authorization|api[_-]?key|access[_-]?token|cookie|set-cookie)$/i.test(key)
        ) {
          return '[REDACTED]'
        }
        if (typeof value === 'string' && apiKey) return value.split(apiKey).join('[REDACTED]')
        return value
      }) + '\n'
    mkdirSync(directory, { recursive: true })
    // 保留一份轮转备份，避免反复失败导致日志无限增长。
    if (existsSync(path) && statSync(path).size >= 5 * 1024 * 1024) {
      renameSync(path, `${path}.1`)
    }
    appendFileSync(path, line, { encoding: 'utf8', mode: 0o600 })
  }
}
