import { describe, expect, it } from 'vitest'
import {
  credentialUpdateSchema,
  modelsBaseUrlOrigin,
  modelsSettingsSummarySchema,
  normalizeModelsBaseUrl,
  saveModelsSettingsInputSchema,
  testModelsConnectionInputSchema
} from '../models'

const VALID_UUID = 'f9364f0f-f3f4-4ea6-a31d-b55754aa2477'

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

describe('save and test input schemas', () => {
  const base = {
    protocol: 'openai-compatible',
    baseUrl: 'https://api.example.com/v1',
    modelId: 'gpt-test',
    credential: { action: 'keep' }
  }

  it('trims baseUrl and modelId on save input', () => {
    expect(
      saveModelsSettingsInputSchema.parse({
        ...base,
        baseUrl: '  https://api.example.com/v1 ',
        modelId: ' gpt-test '
      })
    ).toMatchObject({ baseUrl: 'https://api.example.com/v1', modelId: 'gpt-test' })
  })

  it('rejects unsupported protocols and empty identifiers', () => {
    expect(
      saveModelsSettingsInputSchema.safeParse({ ...base, protocol: 'anthropic' }).success
    ).toBe(false)
    expect(saveModelsSettingsInputSchema.safeParse({ ...base, modelId: '   ' }).success).toBe(false)
  })

  it('requires a uuid requestId on the test input', () => {
    expect(
      testModelsConnectionInputSchema.safeParse({ ...base, requestId: VALID_UUID }).success
    ).toBe(true)
    expect(
      testModelsConnectionInputSchema.safeParse({ ...base, requestId: 'not-a-uuid' }).success
    ).toBe(false)
  })
})

describe('modelsSettingsSummarySchema', () => {
  it('keeps unconfigured and configured as a discriminated union', () => {
    expect(modelsSettingsSummarySchema.parse({ configured: false })).toEqual({ configured: false })
    const configured = {
      configured: true,
      protocol: 'openai-compatible',
      baseUrl: 'https://api.example.com/v1',
      modelId: 'gpt-test',
      hasApiKey: true,
      apiKeyUndecryptable: false
    }
    expect(modelsSettingsSummarySchema.parse(configured)).toEqual(configured)
    // 摘要中没有任何承载密钥本体的字段
    expect(
      Object.keys(configured).some(
        (key) => /key/i.test(key) && key !== 'hasApiKey' && key !== 'apiKeyUndecryptable'
      )
    ).toBe(false)
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
