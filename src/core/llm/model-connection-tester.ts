import type { ModelsErrorCode, TestModelsConnectionResult } from '../../shared/models'
import type { RuntimeModelConfig } from './model-config'
import {
  classifyModelRequestError,
  type CreateLlmClient,
  type ModelRequestErrorKind
} from './llm-client'

export const CONNECTION_TEST_TIMEOUT_MS = 15_000

// 固定的最小测试输入：指令本身显式固定输出语言，不发送会话历史或学习记忆。
const TEST_PROMPT = 'This is a connection test. Reply in English with exactly: ok'

const TEST_ERROR_BY_KIND: Record<ModelRequestErrorKind, ModelsErrorCode> = {
  AUTH: 'TEST_AUTH_FAILED',
  MODEL_UNAVAILABLE: 'TEST_MODEL_UNAVAILABLE',
  TIMEOUT: 'TEST_TIMEOUT',
  NETWORK: 'TEST_NETWORK_ERROR',
  PROTOCOL: 'TEST_UNSUPPORTED_RESPONSE',
  UNKNOWN: 'UNKNOWN_ERROR'
}

type ConfiguredModelConfig = RuntimeModelConfig & { configured: true }

// 连接测试与真实调用共用统一客户端：通信截止时间、取消与用量记账由客户端
// 负责，测试必须使用传入的草稿配置，不读取已保存设置。只证明当次最小请求
// 可用，不保证结构化输出等更高阶能力。
export class ModelConnectionTester {
  constructor(
    private readonly timeoutMs: number = CONNECTION_TEST_TIMEOUT_MS,
    private readonly createClient: CreateLlmClient
  ) {}

  async test(
    config: ConfiguredModelConfig,
    externalSignal: AbortSignal
  ): Promise<TestModelsConnectionResult> {
    if (externalSignal.aborted) {
      return { status: 'error', error: { code: 'TEST_CANCELLED' } }
    }
    try {
      const client = this.createClient(config)
      const completion = await client.complete(
        { model: config.modelId, messages: [{ role: 'user', content: TEST_PROMPT }] },
        { operation: 'connection_test', timeoutMs: this.timeoutMs, signal: externalSignal }
      )
      const content = completion?.choices?.[0]?.message?.content
      if (typeof content !== 'string' || content.length === 0) {
        return { status: 'error', error: { code: 'TEST_UNSUPPORTED_RESPONSE' } }
      }
      return { status: 'ok' }
    } catch (error) {
      if (externalSignal.aborted) {
        return { status: 'error', error: { code: 'TEST_CANCELLED' } }
      }
      const kind = classifyModelRequestError(error)
      return { status: 'error', error: { code: TEST_ERROR_BY_KIND[kind] } }
    }
  }
}
