import { LlmClient, type CreateLlmClient } from '../core/llm/llm-client'
import type { LlmUsageRecorder } from '../core/llm/llm-usage-recorder'
import type { ErrorLogger } from './error-logger'

export function createLlmClientFactory(
  logger: ErrorLogger,
  recorder: LlmUsageRecorder
): CreateLlmClient {
  return (config) => {
    // 在构造客户端前登记实际请求快照；旧密钥保留以覆盖在途请求。
    if (config.apiKey) logger.registerSecret(config.apiKey)
    return new LlmClient(config, recorder)
  }
}
