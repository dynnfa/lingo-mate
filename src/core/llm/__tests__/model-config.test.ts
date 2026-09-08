import { describe, expect, it } from 'vitest'
import type { CredentialUpdate } from '../../../shared/models'
import {
  maskApiKeyForDisplay,
  ModelConfigNotFoundError,
  ModelConfigService,
  ModelConfigValidationError,
  ModelsReadError,
  ModelsWriteError,
  type CredentialVault,
  type ModelsConfigStore
} from '../model-config'

function memoryStore(initial?: unknown): ModelsConfigStore & { records: unknown[] } {
  const records: unknown[] = initial === undefined ? [] : [initial]
  return {
    records,
    read(): unknown {
      if (records.length === 0) return undefined
      return records[records.length - 1]
    },
    write(record: unknown | null): void {
      records.push(record ?? null)
    }
  }
}

// 可控假保险库：加密=前缀标记；可切换可用性与解密失败。
function fakeVault(options: { available?: boolean; breakDecrypt?: boolean } = {}): CredentialVault {
  return {
    isAvailable: () => options.available !== false,
    encrypt: (plainText: string) => `enc:${plainText}`,
    decrypt(serialized: string): string {
      if (options.breakDecrypt) throw new Error('decrypt failed')
      return serialized.replace(/^enc:/, '')
    }
  }
}

// 顺序 ID 工厂：测试中可预判每条记录的 ID。
function sequenceIds(): () => string {
  let next = 0
  return () => {
    next += 1
    return `id-${next}`
  }
}

function draftInput(
  overrides: Partial<{
    baseUrl: string
    modelId: string
    credential: CredentialUpdate
  }> = {}
): {
  protocol: 'openai-compatible'
  baseUrl: string
  modelId: string
  credential: CredentialUpdate
} {
  return {
    protocol: 'openai-compatible',
    baseUrl: 'https://api.example.com/v1/',
    modelId: 'gpt-test',
    credential: { action: 'keep' },
    ...overrides
  }
}

function service(
  store: ModelsConfigStore = memoryStore(),
  vault: CredentialVault = fakeVault(),
  generateId: () => string = sequenceIds()
): ModelConfigService {
  return new ModelConfigService(store, vault, generateId)
}

describe('ModelConfigService collections', () => {
  it('reports an empty collection when no record exists', () => {
    const empty = service()
    expect(empty.getList()).toEqual({ activeConfigId: null, configs: [] })
    expect(empty.resolveSnapshot()).toEqual({ configured: false })
  })

  it('saves two configs independently with isolated credentials and stable ids', () => {
    const store = memoryStore()
    const models = service(store, fakeVault(), sequenceIds())

    const first = models.createConfig(
      draftInput({ credential: { action: 'replace', apiKey: 'sk-1' } })
    )
    expect(first.configs).toHaveLength(1)
    expect(first.activeConfigId).toBe('id-1')
    expect(first.configs[0]).toMatchObject({
      id: 'id-1',
      hasApiKey: true,
      apiKeyUndecryptable: false,
      // 短密钥（≤8 位）整段掩码，不泄露任何片段
      apiKeyPreview: '••••••••'
    })

    // 第二条新增不改变当前模型；keep 在新增语义下表示无密钥，不继承其他记录凭据
    const second = models.createConfig(
      draftInput({
        baseUrl: 'http://127.0.0.1:9000/v1',
        modelId: 'local-model'
      })
    )
    expect(second.activeConfigId).toBe('id-1')
    expect(second.configs[1]).toMatchObject({
      id: 'id-2',
      hasApiKey: false,
      apiKeyUndecryptable: false,
      apiKeyPreview: null
    })

    // 持久化的是整个集合（版本 2）
    expect(store.records[1]).toMatchObject({
      schemaVersion: 2,
      activeConfigId: 'id-1',
      configs: [{ id: 'id-1', credential: 'enc:sk-1' }, { id: 'id-2' }]
    })
  })

  it('updates a record by id without changing the id or the active selection', () => {
    const models = service()
    models.createConfig(draftInput())
    const created = models.createConfig(
      draftInput({ baseUrl: 'http://127.0.0.1:9000/v1', modelId: 'local-model' })
    )
    models.setActiveConfig(created.configs[1].id)

    const updated = models.updateConfig({
      configId: created.configs[1].id,
      ...draftInput({ modelId: 'renamed-model' })
    })

    expect(updated.configs.map((config) => [config.id, config.modelId])).toEqual([
      ['id-1', 'gpt-test'],
      ['id-2', 'renamed-model']
    ])
    expect(updated.activeConfigId).toBe('id-2')
  })

  it('keeps, replaces, and removes a record credential by explicit intent', () => {
    const models = service()
    const created = models.createConfig(
      draftInput({ credential: { action: 'replace', apiKey: 'sk-1' } })
    )
    const configId = created.configs[0].id

    // keep 沿用该记录密钥
    models.updateConfig({ configId, ...draftInput({ modelId: 'kept' }) })
    expect(models.resolveConfigSnapshot(configId)).toMatchObject({ apiKey: 'sk-1' })

    // replace 替换
    models.updateConfig({
      configId,
      ...draftInput({ credential: { action: 'replace', apiKey: 'sk-2' } })
    })
    expect(models.resolveConfigSnapshot(configId)).toMatchObject({ apiKey: 'sk-2' })

    // remove 移除密钥但保留其余配置
    const removed = models.updateConfig({
      configId,
      ...draftInput({ credential: { action: 'remove' } })
    })
    expect(removed.configs[0]).toMatchObject({
      hasApiKey: false,
      apiKeyUndecryptable: false,
      apiKeyPreview: null
    })
    expect(models.resolveConfigSnapshot(configId)).toMatchObject({ apiKey: undefined })
  })

  it('rejects invalid drafts with field-level codes', () => {
    const models = service()
    expect(() =>
      models.createConfig(draftInput({ baseUrl: 'http://remote.example.com/v1' }))
    ).toThrowError(new ModelConfigValidationError('INVALID_BASE_URL', 'baseUrl'))
    expect(() => models.createConfig(draftInput({ modelId: '  ' }))).toThrowError(
      new ModelConfigValidationError('INVALID_MODEL_ID', 'modelId')
    )
  })

  it('forbids keeping a record credential when its base url origin changes', () => {
    const models = service()
    const created = models.createConfig(
      draftInput({ credential: { action: 'replace', apiKey: 'sk-1' } })
    )
    const configId = created.configs[0].id

    expect(() =>
      models.updateConfig({
        configId,
        ...draftInput({ baseUrl: 'https://other.example.com/v1', credential: { action: 'keep' } })
      })
    ).toThrowError(new ModelConfigValidationError('CROSS_ORIGIN_CREDENTIAL', 'apiKey'))

    // 显式 replace / remove 不受跨 origin 限制
    expect(() =>
      models.updateConfig({
        configId,
        ...draftInput({ baseUrl: 'https://other.example.com/v1', credential: { action: 'remove' } })
      })
    ).not.toThrow()
  })

  it('refuses replace when credential storage is unavailable, without downgrading to plaintext', () => {
    const models = service(memoryStore(), fakeVault({ available: false }))
    expect(() =>
      models.createConfig(draftInput({ credential: { action: 'replace', apiKey: 'sk-1' } }))
    ).toThrowError(new ModelConfigValidationError('CREDENTIAL_STORAGE_UNAVAILABLE', 'apiKey'))
  })

  it('marks undecryptable keys instead of silently treating them as unconfigured', () => {
    const store = memoryStore()
    const created = service(store).createConfig(
      draftInput({ credential: { action: 'replace', apiKey: 'sk-1' } })
    )
    const configId = created.configs[0].id

    // 保险库随后无法解密（如系统钥匙串变化）
    const broken = service(store, fakeVault({ breakDecrypt: true }))
    expect(broken.getList().configs[0]).toMatchObject({
      hasApiKey: false,
      apiKeyUndecryptable: true,
      apiKeyPreview: null
    })
    expect(() => broken.resolveConfigSnapshot(configId)).toThrowError(
      new ModelConfigValidationError('CREDENTIAL_DECRYPT_FAILED', 'apiKey')
    )
    expect(() => broken.resolveSnapshot()).toThrowError(
      new ModelConfigValidationError('CREDENTIAL_DECRYPT_FAILED', 'apiKey')
    )

    // keep 一个解不开的密钥必须被拒绝，要求显式 replace/remove
    expect(() =>
      broken.updateConfig({ configId, ...draftInput({ credential: { action: 'keep' } }) })
    ).toThrowError(new ModelConfigValidationError('CREDENTIAL_DECRYPT_FAILED', 'apiKey'))
  })

  it('resolves the active config snapshot and a by-id snapshot without mixing records', () => {
    const models = service()
    const first = models.createConfig(
      draftInput({ credential: { action: 'replace', apiKey: 'sk-1' } })
    )
    const second = models.createConfig(
      draftInput({ baseUrl: 'http://127.0.0.1:9000/v1', modelId: 'local-model' })
    )

    // 默认当前模型是第一条
    expect(models.resolveSnapshot()).toMatchObject({
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'sk-1'
    })

    // 按 ID 解析用于行测试，不读取当前选择
    expect(models.resolveConfigSnapshot(second.configs[1].id)).toMatchObject({
      modelId: 'local-model',
      apiKey: undefined
    })

    models.setActiveConfig(second.configs[1].id)
    expect(models.resolveSnapshot()).toMatchObject({ modelId: 'local-model' })
    expect(first.activeConfigId).toBe('id-1')
  })

  it('deletes records: clearing the active selection only when it is the target', () => {
    const models = service()
    models.createConfig(draftInput())
    const created = models.createConfig(
      draftInput({ baseUrl: 'http://127.0.0.1:9000/v1', modelId: 'local-model' })
    )
    models.setActiveConfig(created.configs[1].id)

    // 删除非当前模型不影响当前模型
    const afterOther = models.deleteConfig('id-1')
    expect(afterOther.activeConfigId).toBe('id-2')
    expect(afterOther.configs).toHaveLength(1)

    // 删除当前模型置空选择，不自动切换
    const afterActive = models.deleteConfig('id-2')
    expect(afterActive).toEqual({ activeConfigId: null, configs: [] })
    expect(models.resolveSnapshot()).toEqual({ configured: false })
  })

  it('rejects operations on missing records instead of implicit creates', () => {
    const models = service()
    expect(() => models.updateConfig({ configId: 'missing', ...draftInput() })).toThrowError(
      new ModelConfigNotFoundError('missing')
    )
    expect(() => models.deleteConfig('missing')).toThrowError(
      new ModelConfigNotFoundError('missing')
    )
    expect(() => models.setActiveConfig('missing')).toThrowError(
      new ModelConfigNotFoundError('missing')
    )
    expect(() => models.resolveConfigSnapshot('missing')).toThrowError(
      new ModelConfigNotFoundError('missing')
    )
    // 指向不存在编辑目标的草稿测试同样失败
    expect(() => models.resolveDraftConfig(draftInput(), 'missing')).toThrowError(
      new ModelConfigNotFoundError('missing')
    )
    // 没有任何记录被隐式创建
    expect(models.getList()).toEqual({ activeConfigId: null, configs: [] })
  })

  it('keeps the previous collection when persistence fails', () => {
    const store = memoryStore()
    const models = service(store)
    models.createConfig(draftInput({ baseUrl: 'https://api.example.com/v1' }))

    const failingStore: ModelsConfigStore = {
      read: store.read,
      write: () => {
        throw new Error('disk full')
      }
    }
    expect(() =>
      service(failingStore).createConfig(draftInput({ baseUrl: 'https://other.example.com/v1' }))
    ).toThrowError(ModelsWriteError)
    expect(models.getList().configs).toHaveLength(1)
    expect(models.getList().configs[0]).toMatchObject({ baseUrl: 'https://api.example.com/v1' })
  })

  it('exposes a masked preview showing only the first and last four key characters', () => {
    const models = service()
    const created = models.createConfig(
      draftInput({ credential: { action: 'replace', apiKey: 'sk-live-abcdef123' } })
    )
    expect(created.configs[0]).toMatchObject({
      hasApiKey: true,
      apiKeyPreview: 'sk-l••••f123'
    })
  })

  it('resolves draft configs for connection tests without persisting them', () => {
    const store = memoryStore()
    const models = service(store)
    models.createConfig(draftInput({ credential: { action: 'replace', apiKey: 'sk-1' } }))

    // 新增草稿：keep 表示无密钥
    const createDraft = models.resolveDraftConfig(
      draftInput({ baseUrl: 'http://127.0.0.1:9000/v1/' })
    )
    expect(createDraft.config).toEqual({
      configured: true,
      protocol: 'openai-compatible',
      baseUrl: 'http://127.0.0.1:9000/v1',
      modelId: 'gpt-test',
      apiKey: undefined
    })

    // 编辑草稿：keep 沿用编辑目标的密钥
    const editDraft = models.resolveDraftConfig(draftInput({ modelId: 'edited' }), 'id-1')
    expect(editDraft.config).toMatchObject({ modelId: 'edited', apiKey: 'sk-1' })

    // 草稿不落盘（存储中只有一次新增写入）
    expect(store.records).toHaveLength(1)
  })
})

describe('ModelConfigService migration and storage', () => {
  const V1_KEYLESS = {
    schemaVersion: 1,
    protocol: 'openai-compatible',
    baseUrl: 'https://api.example.com/v1',
    modelId: 'gpt-test'
  }

  const V1_WITH_KEY = {
    ...V1_KEYLESS,
    credential: 'enc:sk-legacy'
  }

  it('migrates a v1 record without a key into a single-config v2 collection', () => {
    const store = memoryStore(V1_KEYLESS)
    const list = service(store, fakeVault(), () => 'migrated-id').getList()

    expect(list).toEqual({
      activeConfigId: 'migrated-id',
      configs: [
        {
          id: 'migrated-id',
          protocol: 'openai-compatible',
          baseUrl: 'https://api.example.com/v1',
          modelId: 'gpt-test',
          hasApiKey: false,
          apiKeyUndecryptable: false,
          apiKeyPreview: null
        }
      ]
    })
    // 迁移原子落盘为版本 2
    expect(store.records[1]).toMatchObject({ schemaVersion: 2, activeConfigId: 'migrated-id' })
    // 迁移后的记录继续生效
    expect(service(store).resolveSnapshot()).toMatchObject({ modelId: 'gpt-test' })
  })

  it('migrates a v1 record with a key and keeps the ciphertext untouched', () => {
    const store = memoryStore(V1_WITH_KEY)
    const list = service(store).getList()

    expect(list.configs[0]).toMatchObject({
      hasApiKey: true,
      apiKeyUndecryptable: false,
      apiKeyPreview: 'sk-l••••gacy'
    })
    const persisted = store.records[1] as { configs: Array<{ credential?: string }> }
    expect(persisted.configs[0].credential).toBe('enc:sk-legacy')
    expect(service(store).resolveSnapshot()).toMatchObject({ apiKey: 'sk-legacy' })
  })

  it('keeps migrated ids stable across restarts', () => {
    const store = memoryStore(V1_KEYLESS)
    const first = service(store, fakeVault(), () => 'id-a').getList()

    // 第二次读取（新进程）不再迁移，ID 不变
    const second = service(store, fakeVault(), () => 'id-b').getList()
    expect(second).toEqual(first)
    expect(store.records).toHaveLength(2)
  })

  it('keeps the original v1 file and reports the error when migration cannot be written', () => {
    const store = memoryStore(V1_KEYLESS)
    const failingStore: ModelsConfigStore = {
      read: store.read,
      write: () => {
        throw new Error('read-only volume')
      }
    }
    expect(() => service(failingStore).getList()).toThrowError(ModelsWriteError)
    expect(store.records).toHaveLength(1)
    expect(store.records[0]).toMatchObject({ schemaVersion: 1 })
  })

  it('treats corrupted, unknown-version, dangling-active, and duplicate-id records as read failures', () => {
    const corrupt = memoryStore('{"not":"a record"}')
    expect(() => service(corrupt).getList()).toThrowError(ModelsReadError)

    const future = memoryStore({
      schemaVersion: 99,
      activeConfigId: null,
      configs: []
    })
    expect(() => service(future).getList()).toThrowError(ModelsReadError)

    const dangling = memoryStore({
      schemaVersion: 2,
      activeConfigId: 'ghost',
      configs: [
        {
          id: 'id-1',
          protocol: 'openai-compatible',
          baseUrl: 'https://a.example.com/v1',
          modelId: 'm'
        }
      ]
    })
    expect(() => service(dangling).getList()).toThrowError(ModelsReadError)

    const duplicated = memoryStore({
      schemaVersion: 2,
      activeConfigId: 'id-1',
      configs: [
        {
          id: 'id-1',
          protocol: 'openai-compatible',
          baseUrl: 'https://a.example.com/v1',
          modelId: 'm'
        },
        {
          id: 'id-1',
          protocol: 'openai-compatible',
          baseUrl: 'https://b.example.com/v1',
          modelId: 'm'
        }
      ]
    })
    expect(() => service(duplicated).getList()).toThrowError(ModelsReadError)
    // 失败读取不覆盖原文件
    expect(duplicated.records).toHaveLength(1)
  })
})

describe('maskApiKeyForDisplay', () => {
  it('keeps only the first and last four characters of a long key', () => {
    expect(maskApiKeyForDisplay('sk-live-abcdef123')).toBe('sk-l••••f123')
    expect(maskApiKeyForDisplay('secret123')).toBe('secr••••t123')
  })

  it('fully masks keys whose first and last four characters would cover the whole value', () => {
    expect(maskApiKeyForDisplay('secret')).toBe('••••••••')
    expect(maskApiKeyForDisplay('sk-e2e-a')).toBe('••••••••')
    expect(maskApiKeyForDisplay('12345678')).toBe('••••••••')
  })
})
