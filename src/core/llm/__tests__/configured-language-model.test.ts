import { describe, expect, it } from 'vitest'
import { ConfiguredLanguageModel } from '../configured-language-model'
import { ModelConfigService, type CredentialVault, type ModelsConfigStore } from '../model-config'

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

describe('ConfiguredLanguageModel', () => {
  it('throws ModelNotConfiguredError when nothing is saved', async () => {
    const model = new ConfiguredLanguageModel(new ModelConfigService(memoryStore(), vault))
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
})
