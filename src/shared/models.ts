import { z } from 'zod'

export const MODELS_CHANNELS = {
  getSettings: 'models:getSettings',
  saveSettings: 'models:saveSettings',
  testConnection: 'models:testConnection',
  cancelTest: 'models:cancelTest',
  clearSettings: 'models:clearSettings'
} as const

// 首版只支持 OpenAI 兼容协议；展示与校验共用同一来源，不提供尚未实现的选项。
export const MODEL_PROTOCOLS = ['openai-compatible'] as const
export type ModelProtocol = (typeof MODEL_PROTOCOLS)[number]

export const modelProtocolSchema = z.enum(MODEL_PROTOCOLS)

const apiKeySchema = z.string().trim().min(1).max(4_096)

// 凭据更新意图必须显式表达：keep 沿用已存密钥、replace 携带本次输入的新值、
// remove 移除；不使用掩码字符串代表真实密钥，也不让空输入隐式删除。
export const credentialUpdateSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('keep') }),
  z.object({ action: z.literal('replace'), apiKey: apiKeySchema }),
  z.object({ action: z.literal('remove') })
])
export type CredentialUpdate = z.infer<typeof credentialUpdateSchema>

const modelDraftConfigSchema = z.object({
  protocol: modelProtocolSchema,
  baseUrl: z.string().trim().min(1).max(2_048),
  modelId: z.string().trim().min(1).max(200)
})

export const saveModelsSettingsInputSchema = modelDraftConfigSchema.extend({
  credential: credentialUpdateSchema
})
export type SaveModelsSettingsInput = z.infer<typeof saveModelsSettingsInputSchema>

export const testModelsConnectionInputSchema = modelDraftConfigSchema.extend({
  requestId: z.string().uuid(),
  credential: credentialUpdateSchema
})
export type TestModelsConnectionInput = z.infer<typeof testModelsConnectionInputSchema>

export const cancelModelsTestInputSchema = z.object({
  requestId: z.string().uuid()
})
export type CancelModelsTestInput = z.infer<typeof cancelModelsTestInputSchema>

// 安全读取结果：判别联合，未配置不以空字符串伪装有效配置；
// hasApiKey 只表达布尔状态，密钥本体永不回传 Renderer。
export const modelsSettingsSummarySchema = z.discriminatedUnion('configured', [
  z.object({ configured: z.literal(false) }),
  z.object({
    configured: z.literal(true),
    protocol: modelProtocolSchema,
    baseUrl: z.string(),
    modelId: z.string(),
    hasApiKey: z.boolean(),
    // 已保存密钥存在但无法解密时为 true：提示用户重新输入，不静默当作无密钥。
    apiKeyUndecryptable: z.boolean()
  })
])
export type ModelsSettingsSummary = z.infer<typeof modelsSettingsSummarySchema>

export const MODELS_ERROR_CODES = [
  'UNTRUSTED_SOURCE',
  'INVALID_BASE_URL',
  'INVALID_MODEL_ID',
  'INVALID_API_KEY',
  'CROSS_ORIGIN_CREDENTIAL',
  'MODELS_READ_FAILED',
  'MODELS_WRITE_FAILED',
  'CREDENTIAL_STORAGE_UNAVAILABLE',
  'CREDENTIAL_DECRYPT_FAILED',
  'TEST_IN_PROGRESS',
  'TEST_CANCELLED',
  'TEST_TIMEOUT',
  'TEST_AUTH_FAILED',
  'TEST_MODEL_UNAVAILABLE',
  'TEST_NETWORK_ERROR',
  'TEST_UNSUPPORTED_RESPONSE',
  'UNKNOWN_ERROR'
] as const
export type ModelsErrorCode = (typeof MODELS_ERROR_CODES)[number]
export type ModelsErrorField = 'baseUrl' | 'modelId' | 'apiKey'

// 校验错误只携带字段名与错误码，不回传包含密钥的输入或完整校验异常。
export const modelsErrorSchema = z.object({
  code: z.enum(MODELS_ERROR_CODES),
  field: z.enum(['baseUrl', 'modelId', 'apiKey']).optional()
})
export type ModelsError = z.infer<typeof modelsErrorSchema>

export const getModelsSettingsResultSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('ok'), summary: modelsSettingsSummarySchema }),
  z.object({ status: z.literal('error'), error: modelsErrorSchema })
])
export type GetModelsSettingsResult = z.infer<typeof getModelsSettingsResultSchema>

export const saveModelsSettingsResultSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('ok'), summary: modelsSettingsSummarySchema }),
  z.object({ status: z.literal('error'), error: modelsErrorSchema })
])
export type SaveModelsSettingsResult = z.infer<typeof saveModelsSettingsResultSchema>

export const clearModelsSettingsResultSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('ok'), summary: modelsSettingsSummarySchema }),
  z.object({ status: z.literal('error'), error: modelsErrorSchema })
])
export type ClearModelsSettingsResult = z.infer<typeof clearModelsSettingsResultSchema>

export const testModelsConnectionResultSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('ok') }),
  z.object({ status: z.literal('error'), error: modelsErrorSchema })
])
export type TestModelsConnectionResult = z.infer<typeof testModelsConnectionResultSchema>

export const cancelModelsTestResultSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('ok') }),
  z.object({ status: z.literal('error'), error: modelsErrorSchema })
])
export type CancelModelsTestResult = z.infer<typeof cancelModelsTestResultSchema>

export interface ModelsApi {
  getSettings(): Promise<GetModelsSettingsResult>
  saveSettings(input: SaveModelsSettingsInput): Promise<SaveModelsSettingsResult>
  testConnection(input: TestModelsConnectionInput): Promise<TestModelsConnectionResult>
  cancelTest(input: CancelModelsTestInput): Promise<CancelModelsTestResult>
  clearSettings(): Promise<ClearModelsSettingsResult>
}

const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]', '::1'])

export type NormalizedBaseUrl = { ok: true; url: string } | { ok: false }

// Base URL 规则：必须是明确的 API 根地址；允许携带路径，禁止内嵌用户名、密码、
// query 和 fragment；远程地址要求 HTTPS，本机回环地址允许 HTTP；规范化尾部斜杠，
// 不静默重复添加路径。Renderer 与 Core 共用同一实现保证前后端校验一致。
export function normalizeModelsBaseUrl(raw: string): NormalizedBaseUrl {
  let parsed: URL
  try {
    parsed = new URL(raw.trim())
  } catch {
    return { ok: false }
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return { ok: false }
  if (parsed.username || parsed.password) return { ok: false }
  if (parsed.search || parsed.hash) return { ok: false }
  if (parsed.protocol === 'http:' && !LOOPBACK_HOSTNAMES.has(parsed.hostname.toLowerCase())) {
    return { ok: false }
  }

  return { ok: true, url: parsed.href.replace(/\/+$/, '') }
}

export function modelsBaseUrlOrigin(raw: string): string | undefined {
  try {
    return new URL(raw).origin
  } catch {
    return undefined
  }
}
