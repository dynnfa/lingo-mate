import { describe, expect, it } from 'vitest'
import {
  createModelConfigInputSchema,
  credentialUpdateSchema,
  deleteModelConfigInputSchema,
  modelsBaseUrlOrigin,
  modelsConfigListResultSchema,
  modelsConfigListSchema,
  normalizeModelsBaseUrl,
  setActiveModelConfigInputSchema,
  testDraftModelsConnectionInputSchema,
  testSavedModelsConnectionInputSchema,
  updateModelConfigInputSchema
} from '../models'

const VALID_UUID = 'f9364f0f-f3f4-4ea6-a31d-b55754aa2477'
const OTHER_UUID = '0d4b2f7e-52c8-4a61-9ac1-30b1e6de9d02'

const draft = {
  protocol: 'openai-compatible',
  baseUrl: 'https://api.example.com/v1',
  modelId: 'gpt-test',
  credential: { action: 'keep' }
}

describe('credentialUpdateSchema', () => {
  it('accepts keep and remove without any key material', () => {
    expect(credentialUpdateSchema.parse({ action: 'keep' })).toEqual({ action: 'keep' })
    expect(credentialUpdateSchema.parse({ action: 'remove' })).toEqual({ action: 'remove' })
  })

  it('accepts replace with a non-empty key and rejects empty or oversized values', () => {
    expect(credentialUpdateSchema.parse({ action: 'replace', apiKey: ' sk-1 ' })).toEqual({
      action: 'replace',
      apiKey: 'sk-1'
    })
    expect(credentialUpdateSchema.safeParse({ action: 'replace', apiKey: '   ' }).success).toBe(
      false
    )
    expect(
      credentialUpdateSchema.safeParse({ action: 'replace', apiKey: 'x'.repeat(4097) }).success
    ).toBe(false)
  })

  it('rejects unknown actions', () => {
    expect(credentialUpdateSchema.safeParse({ action: 'mask' }).success).toBe(false)
  })
})

describe('config input schemas', () => {
  it('trims baseUrl and modelId on create input', () => {
    expect(
      createModelConfigInputSchema.parse({
        ...draft,
        baseUrl: '  https://api.example.com/v1 ',
        modelId: ' gpt-test '
      })
    ).toMatchObject({ baseUrl: 'https://api.example.com/v1', modelId: 'gpt-test' })
  })

  it('rejects unsupported protocols and empty identifiers', () => {
    expect(
      createModelConfigInputSchema.safeParse({ ...draft, protocol: 'anthropic' }).success
    ).toBe(false)
    expect(createModelConfigInputSchema.safeParse({ ...draft, modelId: '   ' }).success).toBe(false)
  })

  it('requires a uuid configId on id-scoped operations', () => {
    expect(updateModelConfigInputSchema.safeParse({ ...draft, configId: VALID_UUID }).success).toBe(
      true
    )
    expect(updateModelConfigInputSchema.safeParse({ ...draft, configId: 'model-a' }).success).toBe(
      false
    )
    expect(deleteModelConfigInputSchema.safeParse({ configId: VALID_UUID }).success).toBe(true)
    expect(deleteModelConfigInputSchema.safeParse({ configId: 0 }).success).toBe(false)
    expect(setActiveModelConfigInputSchema.safeParse({ configId: VALID_UUID }).success).toBe(true)
  })

  it('shapes the saved and draft test inputs distinctly', () => {
    expect(
      testSavedModelsConnectionInputSchema.safeParse({
        configId: VALID_UUID,
        requestId: OTHER_UUID
      }).success
    ).toBe(true)
    // 行测试不携带草稿字段，也不允许非 uuid 标识
    expect(
      testSavedModelsConnectionInputSchema.safeParse({
        configId: VALID_UUID,
        requestId: 'not-a-uuid'
      }).success
    ).toBe(false)
    expect(
      testSavedModelsConnectionInputSchema.safeParse({
        configId: 'model-a',
        requestId: OTHER_UUID
      }).success
    ).toBe(false)

    expect(
      testDraftModelsConnectionInputSchema.safeParse({
        ...draft,
        requestId: VALID_UUID
      }).success
    ).toBe(true)
    expect(
      testDraftModelsConnectionInputSchema.safeParse({
        ...draft,
        requestId: VALID_UUID,
        editTargetConfigId: OTHER_UUID
      }).success
    ).toBe(true)
    expect(
      testDraftModelsConnectionInputSchema.safeParse({
        ...draft,
        requestId: VALID_UUID,
        editTargetConfigId: 'model-a'
      }).success
    ).toBe(false)
  })
})

describe('modelsConfigListSchema', () => {
  it('describes the collection with per-record safe summaries', () => {
    const list = {
      activeConfigId: VALID_UUID,
      configs: [
        {
          id: VALID_UUID,
          protocol: 'openai-compatible',
          baseUrl: 'https://api.example.com/v1',
          modelId: 'gpt-test',
          hasApiKey: true,
          apiKeyUndecryptable: false,
          apiKeyPreview: 'sk-p••••f123'
        },
        {
          id: OTHER_UUID,
          protocol: 'openai-compatible',
          baseUrl: 'http://127.0.0.1:9000/v1',
          modelId: 'local-model',
          hasApiKey: false,
          apiKeyUndecryptable: false,
          apiKeyPreview: null
        }
      ]
    }
    expect(modelsConfigListSchema.parse(list)).toEqual(list)
    // 摘要中没有任何承载密钥本体的字段
    for (const config of list.configs) {
      expect(
        Object.keys(config).some(
          (key) =>
            /key/i.test(key) &&
            key !== 'hasApiKey' &&
            key !== 'apiKeyUndecryptable' &&
            key !== 'apiKeyPreview'
        )
      ).toBe(false)
    }
  })

  it('bounds the masked preview to the fixed masked length', () => {
    const config = {
      id: VALID_UUID,
      protocol: 'openai-compatible',
      baseUrl: 'https://api.example.com/v1',
      modelId: 'gpt-test',
      hasApiKey: true,
      apiKeyUndecryptable: false,
      apiKeyPreview: 'sk-p••••f123'
    }
    expect(
      modelsConfigListSchema.safeParse({
        activeConfigId: VALID_UUID,
        configs: [config]
      }).success
    ).toBe(true)
    // 超过掩码固定长度的预览视为协议违规，防止字段被用来夹带密钥本体
    expect(
      modelsConfigListSchema.safeParse({
        activeConfigId: VALID_UUID,
        configs: [{ ...config, apiKeyPreview: `${'x'.repeat(13)}` }]
      }).success
    ).toBe(false)
  })

  it('allows an empty selection but rejects dangling or malformed references', () => {
    expect(modelsConfigListSchema.parse({ activeConfigId: null, configs: [] })).toEqual({
      activeConfigId: null,
      configs: []
    })
    expect(modelsConfigListSchema.safeParse({ activeConfigId: '', configs: [] }).success).toBe(
      false
    )
    expect(modelsConfigListSchema.safeParse({ activeConfigId: null }).success).toBe(false)
  })
})

describe('modelsConfigListResultSchema', () => {
  it('wraps the list in the ok/error envelope shared by all mutations', () => {
    expect(
      modelsConfigListResultSchema.parse({
        status: 'ok',
        list: { activeConfigId: null, configs: [] }
      })
    ).toEqual({ status: 'ok', list: { activeConfigId: null, configs: [] } })
    expect(
      modelsConfigListResultSchema.parse({ status: 'error', error: { code: 'CONFIG_NOT_FOUND' } })
    ).toEqual({ status: 'error', error: { code: 'CONFIG_NOT_FOUND' } })
    expect(modelsConfigListResultSchema.safeParse({ status: 'ok' }).success).toBe(false)
  })
})

describe('normalizeModelsBaseUrl', () => {
  it('normalizes trailing slashes on https roots with a path', () => {
    expect(normalizeModelsBaseUrl('https://api.example.com/v1/')).toEqual({
      ok: true,
      url: 'https://api.example.com/v1'
    })
    expect(normalizeModelsBaseUrl('https://api.example.com')).toEqual({
      ok: true,
      url: 'https://api.example.com'
    })
  })

  it('allows http only for loopback hosts', () => {
    expect(normalizeModelsBaseUrl('http://127.0.0.1:9000/v1').ok).toBe(true)
    expect(normalizeModelsBaseUrl('http://localhost:9000').ok).toBe(true)
    expect(normalizeModelsBaseUrl('http://[::1]:9000/v1').ok).toBe(true)
    expect(normalizeModelsBaseUrl('http://api.example.com/v1').ok).toBe(false)
  })

  it('rejects credentials, query strings, fragments, and non-http schemes', () => {
    expect(normalizeModelsBaseUrl('https://user:pass@api.example.com/v1').ok).toBe(false)
    expect(normalizeModelsBaseUrl('https://api.example.com/v1?token=1').ok).toBe(false)
    expect(normalizeModelsBaseUrl('https://api.example.com/v1#section').ok).toBe(false)
    expect(normalizeModelsBaseUrl('ftp://api.example.com/v1').ok).toBe(false)
    expect(normalizeModelsBaseUrl('not a url').ok).toBe(false)
    expect(normalizeModelsBaseUrl('').ok).toBe(false)
  })
})

describe('modelsBaseUrlOrigin', () => {
  it('compares origins including scheme, host, and port', () => {
    expect(modelsBaseUrlOrigin('https://api.example.com/v1')).toBe('https://api.example.com')
    expect(modelsBaseUrlOrigin('https://api.example.com:8443/v1')).toBe(
      'https://api.example.com:8443'
    )
    expect(modelsBaseUrlOrigin('https://other.example.com/v1')).not.toBe(
      modelsBaseUrlOrigin('https://api.example.com/v1')
    )
    expect(modelsBaseUrlOrigin('not a url')).toBeUndefined()
  })
})
