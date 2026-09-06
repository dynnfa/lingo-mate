import {
  modelProtocolSchema,
  modelsBaseUrlOrigin,
  normalizeModelsBaseUrl,
  type CredentialUpdate,
  type ModelsErrorCode,
  type ModelsErrorField,
  type ModelsSettingsSummary,
  type ModelProtocol
} from '../../shared/models'

export const MODELS_CONFIG_SCHEMA_VERSION = 1

// 持久化记录：非敏感配置与加密后的密钥同存一份带版本的记录；
// credential 为序列化后的加密密钥，undefined 表示未配置密钥。
export interface StoredModelsConfig {
  schemaVersion: number
  protocol: ModelProtocol
  baseUrl: string
  modelId: string
  credential?: string
}

// 存储只负责字节与原子性：read 返回原始 JSON 值（undefined 表示无记录），
// 记录的结构校验与解释归本服务；write(null) 表示移除记录。
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

export class ModelConfigService {
  constructor(
    private readonly store: ModelsConfigStore,
    private readonly vault: CredentialVault
  ) {}

  getSummary(): ModelsSettingsSummary {
    const record = this.readStoredRecord()
    if (!record) return { configured: false }
    return this.summarize(record)
  }

  // 每次新请求开始时取得配置快照；在途请求持有自己的快照不受后续保存影响。
  // 已存凭据解密失败时阻止请求，要求用户重新输入或移除。
  resolveSnapshot(): RuntimeModelConfig {
    const record = this.readStoredRecord()
    if (!record) return { configured: false }
    return {
      configured: true,
      protocol: record.protocol,
      baseUrl: record.baseUrl,
      modelId: record.modelId,
      apiKey:
        record.credential === undefined ? undefined : this.decryptCredential(record.credential)
    }
  }

  save(input: DraftConfigInput): ModelsSettingsSummary {
    const resolved = this.resolveDraftConfig(input)
    const record: StoredModelsConfig = {
      schemaVersion: MODELS_CONFIG_SCHEMA_VERSION,
      protocol: resolved.config.protocol,
      baseUrl: resolved.config.baseUrl,
      modelId: resolved.config.modelId,
      ...(resolved.credentialRecord !== undefined ? { credential: resolved.credentialRecord } : {})
    }
    try {
      this.store.write(record)
    } catch (error) {
      throw new ModelsWriteError(error)
    }
    return this.summarize(record)
  }

  clear(): void {
    try {
      this.store.write(null)
    } catch (error) {
      throw new ModelsWriteError(error)
    }
  }

  // 测试连接使用当前草稿而不落盘；与保存共用同一套校验和凭据解析规则。
  resolveDraftConfig(input: DraftConfigInput): ResolvedDraft {
    const baseUrl = normalizeModelsBaseUrl(input.baseUrl)
    if (!baseUrl.ok) {
      throw new ModelConfigValidationError('INVALID_BASE_URL', 'baseUrl')
    }
    const modelId = input.modelId.trim()
    if (!modelId) {
      throw new ModelConfigValidationError('INVALID_MODEL_ID', 'modelId')
    }

    const existing = this.readStoredRecord()
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
    existing: StoredModelsConfig | undefined,
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

  private readStoredRecord(): StoredModelsConfig | undefined {
    let raw: unknown
    try {
      raw = this.store.read()
    } catch (error) {
      throw new ModelsReadError(error)
    }
    return this.parseStoredRecord(raw)
  }

  // 损坏或版本不兼容的记录按读取失败处理，不误判成首次未配置。
  private parseStoredRecord(raw: unknown): StoredModelsConfig | undefined {
    if (raw === null || raw === undefined) return undefined
    if (typeof raw !== 'object' || raw === null)
      throw new ModelsReadError(new Error('malformed record'))

    const record = raw as Partial<StoredModelsConfig>
    if (record.schemaVersion !== MODELS_CONFIG_SCHEMA_VERSION) {
      throw new ModelsReadError(new Error('unsupported schema version'))
    }
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
      schemaVersion: record.schemaVersion,
      protocol: protocol.data,
      baseUrl: record.baseUrl,
      modelId: record.modelId,
      ...(record.credential !== undefined ? { credential: record.credential } : {})
    }
  }

  private summarize(record: StoredModelsConfig): ModelsSettingsSummary {
    const hasCredential = record.credential !== undefined
    let hasApiKey = false
    let apiKeyUndecryptable = false
    if (hasCredential) {
      const decrypted = this.tryDecrypt(record.credential)
      if (decrypted === undefined) {
        apiKeyUndecryptable = true
      } else {
        hasApiKey = true
      }
    }
    return {
      configured: true,
      protocol: record.protocol,
      baseUrl: record.baseUrl,
      modelId: record.modelId,
      hasApiKey,
      apiKeyUndecryptable
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
