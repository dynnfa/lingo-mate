import {
  modelProtocolSchema,
  modelsBaseUrlOrigin,
  normalizeModelsBaseUrl,
  type CredentialUpdate,
  type ModelConfigId,
  type ModelConfigSummary,
  type ModelsConfigList,
  type ModelsErrorCode,
  type ModelsErrorField,
  type ModelProtocol
} from '../../shared/models'

export const MODELS_CONFIG_SCHEMA_VERSION = 2

// 版本 1 持久化记录：单条配置，升级时迁移为单元素集合并设为当前模型。
export interface StoredModelsConfigV1 {
  schemaVersion: 1
  protocol: ModelProtocol
  baseUrl: string
  modelId: string
  credential?: string
}

// 版本 2 持久化记录：配置集合 + 当前模型选择；credential 为序列化后的加密
// 密钥，undefined 表示未配置密钥，绝不进入 Renderer DTO。
export interface StoredModelConfigRecord {
  id: string
  protocol: ModelProtocol
  baseUrl: string
  modelId: string
  credential?: string
}

export interface StoredModelsConfigV2 {
  schemaVersion: 2
  activeConfigId: string | null
  configs: StoredModelConfigRecord[]
}

// 存储只负责字节与原子性：read 返回原始 JSON 值（undefined 表示无记录），
// 记录的结构校验、版本迁移与解释归本服务；write(null) 表示移除记录。
export interface ModelsConfigStore {
  read(): unknown
  write(record: unknown | null): void
}

// 系统安全存储的窄接口；加解密实现由 Main 注入，Core 只依赖语义。
export interface CredentialVault {
  isAvailable(): boolean
  encrypt(plainText: string): string
  decrypt(serialized: string): string
}

export type RuntimeModelConfig =
  | { configured: false }
  | {
      configured: true
      protocol: ModelProtocol
      baseUrl: string
      modelId: string
      apiKey: string | undefined
    }

export class ModelConfigValidationError extends Error {
  constructor(
    readonly code: ModelsErrorCode,
    readonly field?: ModelsErrorField,
    options?: ErrorOptions
  ) {
    super(`Model config validation failed: ${code}`, options)
    this.name = 'ModelConfigValidationError'
  }
}

export class ModelsReadError extends Error {
  constructor(cause: unknown) {
    super('Failed to read models config', { cause })
    this.name = 'ModelsReadError'
  }
}

export class ModelsWriteError extends Error {
  constructor(cause: unknown) {
    super('Failed to write models config', { cause })
    this.name = 'ModelsWriteError'
  }
}

export class ModelNotConfiguredError extends Error {
  constructor() {
    super('No language model is configured')
    this.name = 'ModelNotConfiguredError'
  }
}

// 按 ID 操作不存在的记录是稳定错误：更新不隐式新增，删除/选择/测试不静默跳过。
export class ModelConfigNotFoundError extends Error {
  constructor(readonly configId: ModelConfigId) {
    super(`Model config not found: ${configId}`)
    this.name = 'ModelConfigNotFoundError'
  }
}

// 草稿输入：保存与连接测试共用同一形状（测试额外携带 requestId，由 IPC 层剥离）。
interface DraftConfigInput {
  protocol: ModelProtocol
  baseUrl: string
  modelId: string
  credential: CredentialUpdate
}

interface ResolvedDraft {
  config: RuntimeModelConfig & { configured: true }
  // 需要随本次保存落盘的加密密钥；undefined 表示保存后无密钥。
  credentialRecord: string | undefined
}

const EMPTY_COLLECTION: StoredModelsConfigV2 = {
  schemaVersion: 2,
  activeConfigId: null,
  configs: []
}

// 密钥预览只保留前 4 位与后 4 位，中间用固定 4 个掩码点；长度不超过 8 位的
// 密钥前后段即可覆盖全文，直接整段掩码。掩码长度固定，不泄露密钥长度。
export function maskApiKeyForDisplay(plainText: string): string {
  if (plainText.length <= 8) return '••••••••'
  return `${plainText.slice(0, 4)}••••${plainText.slice(-4)}`
}

export class ModelConfigService {
  constructor(
    private readonly store: ModelsConfigStore,
    private readonly vault: CredentialVault,
    // ID 工厂由 Main 注入：ID 只在此处生成并持久化，跨重启保持稳定。
    private readonly generateConfigId: () => string
  ) {}

  getList(): ModelsConfigList {
    return this.summarizeCollection(this.loadCollection())
  }

  // 每次新请求开始时取得当前模型的配置快照；在途请求持有自己的快照不受
  // 后续保存影响。已存凭据解密失败时阻止请求，要求用户重新输入或移除。
  resolveSnapshot(): RuntimeModelConfig {
    const collection = this.loadCollection()
    if (collection.activeConfigId === null) return { configured: false }
    const record = collection.configs.find((config) => config.id === collection.activeConfigId)
    if (record === undefined) return { configured: false }
    return this.toRuntimeConfig(record)
  }

  // 行测试专用的按 ID 解析入口：不读取也不改变当前模型选择。
  resolveConfigSnapshot(configId: ModelConfigId): RuntimeModelConfig & { configured: true } {
    const record = this.requireRecord(configId)
    return this.toRuntimeConfig(record)
  }

  // 第一条配置新增成功时自动设为当前模型；后续新增不改变选择。
  createConfig(input: DraftConfigInput): ModelsConfigList {
    const resolved = this.resolveDraftConfig(input)
    const record: StoredModelConfigRecord = {
      id: this.generateConfigId(),
      protocol: resolved.config.protocol,
      baseUrl: resolved.config.baseUrl,
      modelId: resolved.config.modelId,
      ...(resolved.credentialRecord !== undefined ? { credential: resolved.credentialRecord } : {})
    }
    const current = this.loadCollection()
    return this.summarizeCollection(
      this.persist({
        schemaVersion: 2,
        activeConfigId: current.configs.length === 0 ? record.id : current.activeConfigId,
        configs: [...current.configs, record]
      })
    )
  }

  // 更新保持记录 ID 和当前模型选择不变；禁止隐式新增。
  updateConfig(input: DraftConfigInput & { configId: ModelConfigId }): ModelsConfigList {
    this.requireRecord(input.configId)
    const resolved = this.resolveDraftConfig(input, input.configId)
    const collection = this.loadCollection()
    return this.summarizeCollection(
      this.persist({
        ...collection,
        configs: collection.configs.map((config) =>
          config.id === input.configId
            ? {
                id: config.id,
                protocol: resolved.config.protocol,
                baseUrl: resolved.config.baseUrl,
                modelId: resolved.config.modelId,
                ...(resolved.credentialRecord !== undefined
                  ? { credential: resolved.credentialRecord }
                  : {})
              }
            : config
        )
      })
    )
  }

  // 删除当前使用模型时把 activeConfigId 置空，不自动切换到其他记录。
  deleteConfig(configId: ModelConfigId): ModelsConfigList {
    const collection = this.loadCollection()
    if (!collection.configs.some((config) => config.id === configId)) {
      throw new ModelConfigNotFoundError(configId)
    }
    return this.summarizeCollection(
      this.persist({
        ...collection,
        activeConfigId: collection.activeConfigId === configId ? null : collection.activeConfigId,
        configs: collection.configs.filter((config) => config.id !== configId)
      })
    )
  }

  setActiveConfig(configId: ModelConfigId): ModelsConfigList {
    this.requireRecord(configId)
    const collection = this.loadCollection()
    return this.summarizeCollection(this.persist({ ...collection, activeConfigId: configId }))
  }

  // 测试连接使用当前草稿而不落盘；与保存共用同一套校验和凭据解析规则。
  // existingId 存在时凭据 keep 归属该记录（编辑目标），不存在时新增草稿不
  // 继承任何已存凭据；指向不存在的记录按稳定错误处理。
  resolveDraftConfig(input: DraftConfigInput, existingId?: ModelConfigId): ResolvedDraft {
    const baseUrl = normalizeModelsBaseUrl(input.baseUrl)
    if (!baseUrl.ok) {
      throw new ModelConfigValidationError('INVALID_BASE_URL', 'baseUrl')
    }
    const modelId = input.modelId.trim()
    if (!modelId) {
      throw new ModelConfigValidationError('INVALID_MODEL_ID', 'modelId')
    }

    const existing = existingId !== undefined ? this.findRecord(existingId) : undefined
    if (existingId !== undefined && existing === undefined) {
      throw new ModelConfigNotFoundError(existingId)
    }
    const credential = this.resolveCredential(input.credential, existing, baseUrl.url)
    return {
      config: {
        configured: true,
        protocol: input.protocol,
        baseUrl: baseUrl.url,
        modelId,
        apiKey: credential.plain
      },
      credentialRecord: credential.encrypted
    }
  }

  private resolveCredential(
    update: CredentialUpdate,
    existing: StoredModelConfigRecord | undefined,
    newBaseUrl: string
  ): { plain: string | undefined; encrypted: string | undefined } {
    switch (update.action) {
      case 'keep': {
        const encrypted = existing?.credential
        if (encrypted === undefined) {
          return { plain: undefined, encrypted: undefined }
        }
        // 已存密钥必须继续可用才允许 keep：更换 origin 时旧凭据不允许自动带给
        // 新地址；密钥解不开时要求显式 replace 或 remove，不静默保留坏密钥。
        if (existing && modelsBaseUrlOrigin(existing.baseUrl) !== modelsBaseUrlOrigin(newBaseUrl)) {
          throw new ModelConfigValidationError('CROSS_ORIGIN_CREDENTIAL', 'apiKey')
        }
        return { plain: this.decryptCredential(encrypted), encrypted }
      }
      case 'replace': {
        if (!this.vault.isAvailable()) {
          throw new ModelConfigValidationError('CREDENTIAL_STORAGE_UNAVAILABLE', 'apiKey')
        }
        return { plain: update.apiKey, encrypted: this.vault.encrypt(update.apiKey) }
      }
      case 'remove':
        return { plain: undefined, encrypted: undefined }
    }
  }

  private findRecord(configId: ModelConfigId): StoredModelConfigRecord | undefined {
    return this.loadCollection().configs.find((config) => config.id === configId)
  }

  private requireRecord(configId: ModelConfigId): StoredModelConfigRecord {
    const record = this.findRecord(configId)
    if (record === undefined) throw new ModelConfigNotFoundError(configId)
    return record
  }

  private toRuntimeConfig(record: StoredModelConfigRecord): RuntimeModelConfig & {
    configured: true
  } {
    return {
      configured: true,
      protocol: record.protocol,
      baseUrl: record.baseUrl,
      modelId: record.modelId,
      apiKey:
        record.credential === undefined ? undefined : this.decryptCredential(record.credential)
    }
  }

  // 读取 + 版本迁移：迁移成功必须原子落盘（ID 跨重启稳定）；失败抛出错误并
  // 保留原文件。损坏或未知版本按读取失败处理，不覆盖为空集合。
  private loadCollection(): StoredModelsConfigV2 {
    let raw: unknown
    try {
      raw = this.store.read()
    } catch (error) {
      throw new ModelsReadError(error)
    }
    if (raw === null || raw === undefined) return EMPTY_COLLECTION
    if (typeof raw !== 'object' || raw === null) {
      throw new ModelsReadError(new Error('malformed record'))
    }

    const version = (raw as { schemaVersion?: unknown }).schemaVersion
    if (version === 1) {
      return this.migrateV1(this.parseV1Record(raw))
    }
    if (version === 2) {
      return this.parseV2Collection(raw)
    }
    throw new ModelsReadError(new Error('unsupported schema version'))
  }

  private migrateV1(record: StoredModelsConfigV1): StoredModelsConfigV2 {
    const id = this.generateConfigId()
    const migrated: StoredModelsConfigV2 = {
      schemaVersion: 2,
      activeConfigId: id,
      configs: [
        {
          id,
          protocol: record.protocol,
          baseUrl: record.baseUrl,
          modelId: record.modelId,
          ...(record.credential !== undefined ? { credential: record.credential } : {})
        }
      ]
    }
    return this.persist(migrated)
  }

  private parseV1Record(raw: unknown): StoredModelsConfigV1 {
    const record = raw as Partial<StoredModelsConfigV1>
    const protocol = modelProtocolSchema.safeParse(record.protocol)
    if (
      !protocol.success ||
      typeof record.baseUrl !== 'string' ||
      !normalizeModelsBaseUrl(record.baseUrl).ok ||
      typeof record.modelId !== 'string' ||
      record.modelId.trim().length === 0 ||
      (record.credential !== undefined && typeof record.credential !== 'string')
    ) {
      throw new ModelsReadError(new Error('malformed record'))
    }
    return {
      schemaVersion: 1,
      protocol: protocol.data,
      baseUrl: record.baseUrl,
      modelId: record.modelId,
      ...(record.credential !== undefined ? { credential: record.credential } : {})
    }
  }

  // activeConfigId 必须为空或指向存在的记录；重复 ID 视为损坏数据。
  private parseV2Collection(raw: unknown): StoredModelsConfigV2 {
    const record = raw as Partial<StoredModelsConfigV2>
    if (!Array.isArray(record.configs)) {
      throw new ModelsReadError(new Error('malformed record'))
    }
    const configs: StoredModelConfigRecord[] = []
    const seenIds = new Set<string>()
    for (const entry of record.configs) {
      if (typeof entry !== 'object' || entry === null) {
        throw new ModelsReadError(new Error('malformed record'))
      }
      const config = entry as Partial<StoredModelConfigRecord>
      const protocol = modelProtocolSchema.safeParse(config.protocol)
      if (
        typeof config.id !== 'string' ||
        config.id.trim().length === 0 ||
        seenIds.has(config.id) ||
        !protocol.success ||
        typeof config.baseUrl !== 'string' ||
        !normalizeModelsBaseUrl(config.baseUrl).ok ||
        typeof config.modelId !== 'string' ||
        config.modelId.trim().length === 0 ||
        (config.credential !== undefined && typeof config.credential !== 'string')
      ) {
        throw new ModelsReadError(new Error('malformed record'))
      }
      seenIds.add(config.id)
      configs.push({
        id: config.id,
        protocol: protocol.data,
        baseUrl: config.baseUrl,
        modelId: config.modelId,
        ...(config.credential !== undefined ? { credential: config.credential } : {})
      })
    }
    if (
      record.activeConfigId !== null &&
      (typeof record.activeConfigId !== 'string' || !seenIds.has(record.activeConfigId))
    ) {
      throw new ModelsReadError(new Error('dangling activeConfigId'))
    }
    return {
      schemaVersion: 2,
      activeConfigId: record.activeConfigId ?? null,
      configs
    }
  }

  private persist(collection: StoredModelsConfigV2): StoredModelsConfigV2 {
    try {
      this.store.write(collection)
    } catch (error) {
      throw new ModelsWriteError(error)
    }
    return collection
  }

  private summarizeCollection(collection: StoredModelsConfigV2): ModelsConfigList {
    return {
      activeConfigId: collection.activeConfigId,
      configs: collection.configs.map((config) => this.summarize(config))
    }
  }

  private summarize(record: StoredModelConfigRecord): ModelConfigSummary {
    const hasCredential = record.credential !== undefined
    let hasApiKey = false
    let apiKeyUndecryptable = false
    let apiKeyPreview: string | null = null
    if (hasCredential) {
      const decrypted = this.tryDecrypt(record.credential)
      if (decrypted === undefined) {
        apiKeyUndecryptable = true
      } else {
        hasApiKey = true
        apiKeyPreview = maskApiKeyForDisplay(decrypted)
      }
    }
    return {
      id: record.id,
      protocol: record.protocol,
      baseUrl: record.baseUrl,
      modelId: record.modelId,
      hasApiKey,
      apiKeyUndecryptable,
      apiKeyPreview
    }
  }

  private decryptCredential(serialized: string): string {
    try {
      if (!this.vault.isAvailable()) throw new Error('Credential vault unavailable')
      const plain = this.vault.decrypt(serialized)
      if (!plain.trim()) throw new Error('Empty decrypted credential')
      return plain
    } catch (cause) {
      throw new ModelConfigValidationError('CREDENTIAL_DECRYPT_FAILED', 'apiKey', { cause })
    }
  }

  private tryDecrypt(serialized: string | undefined): string | undefined {
    if (serialized === undefined) return undefined
    try {
      return this.decryptCredential(serialized)
    } catch {
      return undefined
    }
  }
}
