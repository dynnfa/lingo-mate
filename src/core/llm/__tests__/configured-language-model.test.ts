import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { ConfiguredLanguageModel } from '../configured-language-model'
import {
  ModelConfigService,
  ModelNotConfiguredError,
  type CredentialVault,
  type ModelsConfigStore
} from '../model-config'
import { LlmClient, type CreateLlmClient } from '../llm-client'
import { LlmUsageRecorder } from '../llm-usage-recorder'

// 快照隔离与“保存后下一次请求生效”由 tests/integration 的假服务测试覆盖。
function memoryStore(): ModelsConfigStore {
  return {
    read: () => null,
    write: () => {}
  }
}

const vault: CredentialVault = {
  isAvailable: () => true,
  encrypt: (plainText) => `enc:${plainText}`,
  decrypt: (serialized) => serialized.replace(/^enc:/, '')
}

const createClient: CreateLlmClient = (config) =>
  new LlmClient(
    config,
    new LlmUsageRecorder({
      insertStarted: () => {},
      finish: () => {},
      markInterruptedStarted: () => 0,
      list: () => []
    })
  )

describe('ConfiguredLanguageModel', () => {
  it('throws ModelNotConfiguredError when nothing is saved', async () => {
    const model = new ConfiguredLanguageModel(
      new ModelConfigService(memoryStore(), vault, randomUUID),
      createClient
    )
    const stream = model.streamReply({
      messages: [{ role: 'user', content: 'Hello' }],
      outputLanguage: 'en',
      targetLanguage: 'en',
      signal: new AbortController().signal
    })

    await expect(stream[Symbol.asyncIterator]().next()).rejects.toMatchObject({
      name: 'ModelNotConfiguredError'
    })
  })
  it('creates a run-bound model snapshot and reports missing configuration before a host call', () => {
    const model = new ConfiguredLanguageModel(
      new ModelConfigService(memoryStore(), vault, randomUUID),
      createClient
    )
    expect(() => model.snapshot()).toThrowError(ModelNotConfiguredError)
  })
})
