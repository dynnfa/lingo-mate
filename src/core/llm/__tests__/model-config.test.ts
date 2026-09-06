import { describe, expect, it } from 'vitest'
import type { CredentialUpdate } from '../../../shared/models'
import {
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

function saveInput(
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

describe('ModelConfigService', () => {
  it('reports unconfigured when no record exists', () => {
    const service = new ModelConfigService(memoryStore(), fakeVault())
    expect(service.getSummary()).toEqual({ configured: false })
    expect(service.resolveSnapshot()).toEqual({ configured: false })
  })

  it('saves a normalized keyless record and reports a summary without key material', () => {
    const store = memoryStore()
    const service = new ModelConfigService(store, fakeVault())

    const summary = service.save(saveInput())

    expect(summary).toEqual({
      configured: true,
      protocol: 'openai-compatible',
      baseUrl: 'https://api.example.com/v1',
      modelId: 'gpt-test',
      hasApiKey: false,
      apiKeyUndecryptable: false
    })
    expect(store.records[0]).toEqual({
      schemaVersion: 1,
      protocol: 'openai-compatible',
      baseUrl: 'https://api.example.com/v1',
      modelId: 'gpt-test'
    })
  })

  it('keeps, replaces, and removes the stored credential by explicit intent', () => {
    const service = new ModelConfigService(memoryStore(), fakeVault())

    service.save(saveInput({ credential: { action: 'replace', apiKey: 'sk-1' } }))
    expect(service.getSummary()).toMatchObject({ hasApiKey: true, apiKeyUndecryptable: false })
    expect(service.resolveSnapshot()).toMatchObject({ apiKey: 'sk-1' })

    // keep 沿用旧密钥
    service.save(saveInput({ credential: { action: 'keep' } }))
    expect(service.resolveSnapshot()).toMatchObject({ apiKey: 'sk-1' })

    // remove 移除密钥但保留其余配置
    service.save(saveInput({ credential: { action: 'remove' } }))
    expect(service.getSummary()).toMatchObject({ configured: true, hasApiKey: false })
    expect(service.resolveSnapshot()).toMatchObject({ apiKey: undefined })
  })

  it('rejects invalid drafts with field-level codes', () => {
    const service = new ModelConfigService(memoryStore(), fakeVault())

    expect(() => service.save(saveInput({ baseUrl: 'http://remote.example.com/v1' }))).toThrowError(
      new ModelConfigValidationError('INVALID_BASE_URL', 'baseUrl')
    )
    expect(() => service.save(saveInput({ modelId: '  ' }))).toThrowError(
      new ModelConfigValidationError('INVALID_MODEL_ID', 'modelId')
    )
  })

  it('forbids keeping a stored credential when the base url origin changes', () => {
    const service = new ModelConfigService(memoryStore(), fakeVault())
    service.save(saveInput({ credential: { action: 'replace', apiKey: 'sk-1' } }))

    expect(() =>
      service.save(
        saveInput({
          baseUrl: 'https://other.example.com/v1',
          credential: { action: 'keep' }
        })
      )
    ).toThrowError(new ModelConfigValidationError('CROSS_ORIGIN_CREDENTIAL', 'apiKey'))

    // 显式 replace / remove 不受跨 origin 限制
    expect(() =>
      service.save(
        saveInput({
          baseUrl: 'https://other.example.com/v1',
          credential: { action: 'remove' }
        })
      )
    ).not.toThrow()
  })

  it('refuses replace when credential storage is unavailable, without downgrading to plaintext', () => {
    const service = new ModelConfigService(memoryStore(), fakeVault({ available: false }))
    expect(() =>
      service.save(saveInput({ credential: { action: 'replace', apiKey: 'sk-1' } }))
    ).toThrowError(new ModelConfigValidationError('CREDENTIAL_STORAGE_UNAVAILABLE', 'apiKey'))
  })

  it('marks undecryptable keys instead of silently treating them as unconfigured', () => {
    const store = memoryStore()
    const service = new ModelConfigService(store, fakeVault())
    service.save(saveInput({ credential: { action: 'replace', apiKey: 'sk-1' } }))

    // 保险库随后无法解密（如系统钥匙串变化）
    const broken = new ModelConfigService(store, fakeVault({ breakDecrypt: true }))
    expect(broken.getSummary()).toMatchObject({ hasApiKey: false, apiKeyUndecryptable: true })
    expect(() => broken.resolveSnapshot()).toThrowError(
      new ModelConfigValidationError('CREDENTIAL_DECRYPT_FAILED', 'apiKey')
    )

    // keep 一个解不开的密钥必须被拒绝，要求显式 replace/remove
    expect(() => broken.save(saveInput({ credential: { action: 'keep' } }))).toThrowError(
      new ModelConfigValidationError('CREDENTIAL_DECRYPT_FAILED', 'apiKey')
    )
  })

  it('treats corrupted or version-mismatched records as read failures', () => {
    const corrupt = memoryStore('{"not":"a record"}')
    expect(() => new ModelConfigService(corrupt, fakeVault()).getSummary()).toThrowError(
      ModelsReadError
    )

    const future = memoryStore({
      schemaVersion: 99,
      protocol: 'openai-compatible',
      baseUrl: 'https://api.example.com/v1',
      modelId: 'gpt-test'
    })
    expect(() => new ModelConfigService(future, fakeVault()).getSummary()).toThrowError(
      ModelsReadError
    )
  })

  it('keeps the previous record when persistence fails', () => {
    const store = memoryStore()
    const service = new ModelConfigService(store, fakeVault())
    service.save(saveInput({ baseUrl: 'https://api.example.com/v1' }))

    const failingStore: ModelsConfigStore = {
      read: store.read,
      write: () => {
        throw new Error('disk full')
      }
    }
    expect(() =>
      new ModelConfigService(failingStore, fakeVault()).save(
        saveInput({ baseUrl: 'https://other.example.com/v1' })
      )
    ).toThrowError(ModelsWriteError)
    expect(service.getSummary()).toMatchObject({ baseUrl: 'https://api.example.com/v1' })
  })

  it('clears the record entirely', () => {
    const store = memoryStore()
    const service = new ModelConfigService(store, fakeVault())
    service.save(saveInput({ credential: { action: 'replace', apiKey: 'sk-1' } }))

    service.clear()

    expect(service.getSummary()).toEqual({ configured: false })
  })

  it('resolves draft configs for connection tests without persisting them', () => {
    const store = memoryStore()
    const service = new ModelConfigService(store, fakeVault())

    const draft = service.resolveDraftConfig(
      saveInput({
        baseUrl: 'http://127.0.0.1:9000/v1/',
        credential: { action: 'replace', apiKey: 'sk-local' }
      })
    )

    expect(draft.config).toEqual({
      configured: true,
      protocol: 'openai-compatible',
      baseUrl: 'http://127.0.0.1:9000/v1',
      modelId: 'gpt-test',
      apiKey: 'sk-local'
    })
    // 草稿不落盘
    expect(store.records).toHaveLength(0)
  })
})
