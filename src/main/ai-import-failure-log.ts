import type { ErrorLogger } from './error-logger'
import type { VocabularyAnalysisFailure } from '../core/learning/vocabulary/llm-vocabulary-analyzer'

// AI 导入失败诊断适配器：把分析失败映射为公共按天错误日志的一条记录。
// 用户明确授权保存失败的模型响应；不记录请求、配置或 SDK 错误对象。
// 脱敏（敏感字段与已知密钥）由公共日志服务统一完成，Main 是唯一写入方，
// 日志不转发到 Renderer 或控制台，也不再写独立的 ai-import-errors.log。
export function createAiImportFailureDiagnostic(
  logger: ErrorLogger
): (failure: VocabularyAnalysisFailure, apiKey?: string) => void {
  return (failure, apiKey) => {
    // 在途请求可能仍在使用已下线的密钥；登记后只增不减，保证脱敏覆盖。
    if (apiKey) logger.registerSecret(apiKey)
    logger.log({
      source: 'core',
      module: 'ai-import',
      operation: 'analyze',
      code: failure.code,
      message: `vocabulary analysis failed at stage ${failure.stage}`,
      context: { ...failure }
    })
  }
}
