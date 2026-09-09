import { z } from 'zod'

export const MODELS_CHANNELS = {
  listConfigs: 'models:listConfigs',
  createConfig: 'models:createConfig',
  updateConfig: 'models:updateConfig',
  deleteConfig: 'models:deleteConfig',
  setActiveConfig: 'models:setActiveConfig',
  testSavedConnection: 'models:testSavedConnection',
  testDraftConnection: 'models:testDraftConnection',
  cancelTest: 'models:cancelTest'
} as const

// 展示与校验共用已实现的协议列表。
export const MODEL_PROTOCOLS = ['openai-compatible', 'gemini'] as const
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

// 记录 ID 由 Main 注入 Core 的 ID 工厂生成（UUID），不使用 Model ID 或
// 数组下标作主键；协议层统一按 UUID 校验，非法 ID 返回稳定错误码。
export const modelConfigIdSchema = z.string().uuid()
export type ModelConfigId = string

const modelDraftConfigSchema = z.object({
  protocol: modelProtocolSchema,
  baseUrl: z.string().trim().min(1).max(2_048),
  modelId: z.string().trim().min(1).max(200)
})

export const createModelConfigInputSchema = modelDraftConfigSchema.extend({
  credential: credentialUpdateSchema
})
export type CreateModelConfigInput = z.infer<typeof createModelConfigInputSchema>

export const updateModelConfigInputSchema = createModelConfigInputSchema.extend({
  configId: modelConfigIdSchema
})
export type UpdateModelConfigInput = z.infer<typeof updateModelConfigInputSchema>

export const deleteModelConfigInputSchema = z.object({
  configId: modelConfigIdSchema
})
export type DeleteModelConfigInput = z.infer<typeof deleteModelConfigInputSchema>

export const setActiveModelConfigInputSchema = z.object({
  configId: modelConfigIdSchema
})
export type SetActiveModelConfigInput = z.infer<typeof setActiveModelConfigInputSchema>

// 行测试只提交 configId 与 requestId：目标配置和密钥由 Main 调用 Core 从
// 存储读取，Renderer 草稿不影响已保存版本。
export const testSavedModelsConnectionInputSchema = z.object({
  configId: modelConfigIdSchema,
  requestId: z.string().uuid()
})
export type TestSavedModelsConnectionInput = z.infer<typeof testSavedModelsConnectionInputSchema>

// 草稿测试携带当前表单输入；编辑已有配置时通过 editTargetConfigId 显式
// 声明凭据 keep 归属哪条记录，新增草稿不继承任何已存凭据。
export const testDraftModelsConnectionInputSchema = modelDraftConfigSchema.extend({
  requestId: z.string().uuid(),
  editTargetConfigId: modelConfigIdSchema.optional(),
  credential: credentialUpdateSchema
})
export type TestDraftModelsConnectionInput = z.infer<typeof testDraftModelsConnectionInputSchema>

export const cancelModelsTestInputSchema = z.object({
  requestId: z.string().uuid()
})
export type CancelModelsTestInput = z.infer<typeof cancelModelsTestInputSchema>

// 安全摘要：逐条记录只暴露非敏感字段、密钥布尔状态与脱敏预览，密钥本体
//（明文或密文）永不回传 Renderer。
export const modelConfigSummarySchema = z.object({
  id: z.string().min(1),
  protocol: modelProtocolSchema,
  baseUrl: z.string(),
  modelId: z.string(),
  hasApiKey: z.boolean(),
  // 已保存密钥存在但无法解密时为 true：提示用户重新配置，不静默当作无密钥。
  apiKeyUndecryptable: z.boolean(),
  // 脱敏预览：前 4 位 + 固定掩码 + 后 4 位，由 Core 在持有明文的进程内生成；
  // null 表示无密钥或密钥不可解。长度上限即预览固定长度，超出视为协议违规。
  apiKeyPreview: z.string().min(1).max(12).nullable()
})
export type ModelConfigSummary = z.infer<typeof modelConfigSummarySchema>

export const modelsConfigListSchema = z.object({
  // 当前使用模型：null 表示尚未选择（不回退到任何默认记录）。
  activeConfigId: z.string().min(1).nullable(),
  configs: z.array(modelConfigSummarySchema)
})
export type ModelsConfigList = z.infer<typeof modelsConfigListSchema>

export const MODELS_ERROR_CODES = [
  'UNTRUSTED_SOURCE',
  'INVALID_CONFIG_ID',
  'CONFIG_NOT_FOUND',
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

// 集合读取 / 变更操作共用同一结果形状：成功携带完整安全列表。
export const modelsConfigListResultSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('ok'), list: modelsConfigListSchema }),
  z.object({ status: z.literal('error'), error: modelsErrorSchema })
])
export type ModelsConfigListResult = z.infer<typeof modelsConfigListResultSchema>

export const listModelsConfigsResultSchema = modelsConfigListResultSchema
export const createModelConfigResultSchema = modelsConfigListResultSchema
export const updateModelConfigResultSchema = modelsConfigListResultSchema
export const deleteModelConfigResultSchema = modelsConfigListResultSchema
export const setActiveModelConfigResultSchema = modelsConfigListResultSchema
export type ListModelsConfigsResult = ModelsConfigListResult
export type CreateModelConfigResult = ModelsConfigListResult
export type UpdateModelConfigResult = ModelsConfigListResult
export type DeleteModelConfigResult = ModelsConfigListResult
export type SetActiveModelConfigResult = ModelsConfigListResult

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
  listConfigs(): Promise<ModelsConfigListResult>
  createConfig(input: CreateModelConfigInput): Promise<CreateModelConfigResult>
  updateConfig(input: UpdateModelConfigInput): Promise<UpdateModelConfigResult>
  deleteConfig(input: DeleteModelConfigInput): Promise<DeleteModelConfigResult>
  setActiveConfig(input: SetActiveModelConfigInput): Promise<SetActiveModelConfigResult>
  testSavedConnection(input: TestSavedModelsConnectionInput): Promise<TestModelsConnectionResult>
  testDraftConnection(input: TestDraftModelsConnectionInput): Promise<TestModelsConnectionResult>
  cancelTest(input: CancelModelsTestInput): Promise<CancelModelsTestResult>
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
