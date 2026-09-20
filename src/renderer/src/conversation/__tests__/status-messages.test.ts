import { describe, expect, it } from 'vitest'
import type { TFunction } from 'i18next'
import { createI18n } from '../../i18n'
import type { ConversationStatus } from '../conversation-state'
import { translateConversationStatus } from '../status-messages'

const zh = createI18n('zh-CN')
const en = createI18n('en')

function cases(): ConversationStatus[] {
  return [
    { kind: 'restoring' },
    { kind: 'switching' },
    { kind: 'creating' },
    { kind: 'ready' },
    { kind: 'generating' },
    { kind: 'completed' },
    { kind: 'cancelled' },
    { kind: 'protocolError' },
    { kind: 'generationError', error: { code: 'MODEL_ERROR' } },
    { kind: 'generationError', error: { code: 'MODEL_NOT_CONFIGURED' } },
    { kind: 'generationError', error: { code: 'TOOL_CALL_NOT_SUPPORTED' } },
    { kind: 'generationError', error: { code: 'CREDENTIAL_DECRYPT_FAILED' } },
    { kind: 'generationError', error: { code: 'PERSISTENCE_ERROR' } },
    { kind: 'generationError', error: { code: 'UNKNOWN_ERROR' } },
    { kind: 'skillPhase', phase: 'analyzing' },
    { kind: 'skillPhase', phase: 'analyzing', skillId: 'phrase' },
    { kind: 'skillPhase', phase: 'committing', skillId: 'vocabulary' },
    { kind: 'skillPhase', phase: 'committing', skillId: 'phrase' },
    { kind: 'skillPhase', phase: 'summarizing' },
    { kind: 'skillDescriptionFailed', cancelled: false },
    { kind: 'skillDescriptionFailed', cancelled: false, skillId: 'phrase' },
    { kind: 'skillDescriptionFailed', cancelled: true, skillId: 'phrase' },
    { kind: 'skillDescriptionFailed', cancelled: true, skillId: 'vocabulary' },
    {
      kind: 'requestError',
      operation: 'load',
      error: { code: 'NOT_FOUND', resource: 'conversation' }
    },
    { kind: 'requestError', operation: 'load', error: { code: 'NOT_FOUND', resource: 'message' } },
    { kind: 'requestError', operation: 'list', error: { code: 'CONVERSATION_BUSY' } },
    { kind: 'requestError', operation: 'send', error: { code: 'REQUEST_BUSY' } },
    { kind: 'requestError', operation: 'retry', error: { code: 'RETRY_NOT_ALLOWED' } },
    { kind: 'requestError', operation: 'cancel', error: { code: 'REQUEST_NOT_FOUND' } },
    { kind: 'requestError', operation: 'load', error: { code: 'PERSISTENCE_ERROR' } },
    { kind: 'requestError', operation: 'send', error: { code: 'UNKNOWN_ERROR' } },
    { kind: 'ipcError', operation: 'load' },
    { kind: 'ipcError', operation: 'list' },
    { kind: 'ipcError', operation: 'create' },
    { kind: 'ipcError', operation: 'send' },
    { kind: 'ipcError', operation: 'cancel' },
    { kind: 'ipcError', operation: 'retry' }
  ]
}

describe('conversation status translation', () => {
  it.each(cases())('translates %j into non-empty text in both languages', (status) => {
    const zhText = translateConversationStatus(
      zh.t as TFunction<['common', 'conversation', 'errors']>,
      status
    )
    const enText = translateConversationStatus(
      en.t as TFunction<['common', 'conversation', 'errors']>,
      status
    )

    expect(zhText.trim()).not.toBe('')
    expect(enText.trim()).not.toBe('')
    // 未翻译的 key 会原样返回，不应看到命名空间前缀
    expect(zhText).not.toMatch(/^(common|conversation|errors):/)
    expect(enText).not.toMatch(/^(common|conversation|errors):/)
  })

  it('translates skill phases per skill id', () => {
    const zh = createI18n('zh-CN')
    const t = zh.t as TFunction<['common', 'conversation', 'errors']>
    expect(
      translateConversationStatus(t, { kind: 'skillPhase', phase: 'analyzing', skillId: 'phrase' })
    ).toBe('正在解析短语…')
    expect(
      translateConversationStatus(t, { kind: 'skillPhase', phase: 'committing', skillId: 'phrase' })
    ).toBe('正在收录短语…')
    expect(
      translateConversationStatus(t, {
        kind: 'skillPhase',
        phase: 'analyzing',
        skillId: 'vocabulary'
      })
    ).toBe('正在解析词汇…')
    expect(translateConversationStatus(t, { kind: 'skillPhase', phase: 'analyzing' })).toBe(
      '正在解析词汇…'
    )
    expect(
      translateConversationStatus(t, {
        kind: 'skillDescriptionFailed',
        cancelled: false,
        skillId: 'phrase'
      })
    ).toBe('短语已处理，但结果描述失败。你可以只重试结果描述。')
  })

  it('translates explore-phrase phases with generation wording', () => {
    const zh = createI18n('zh-CN')
    const t = zh.t as TFunction<['common', 'conversation', 'errors']>
    expect(
      translateConversationStatus(t, {
        kind: 'skillPhase',
        phase: 'analyzing',
        skillId: 'explore-phrase'
      })
    ).toBe('正在生成短语…')
    expect(
      translateConversationStatus(t, {
        kind: 'skillPhase',
        phase: 'committing',
        skillId: 'explore-phrase'
      })
    ).toBe('正在保存生成的短语…')
    const en = createI18n('en')
    const enT = en.t as TFunction<['common', 'conversation', 'errors']>
    expect(
      translateConversationStatus(enT, {
        kind: 'skillPhase',
        phase: 'analyzing',
        skillId: 'explore-phrase'
      })
    ).toBe('Generating phrases…')
  })

  it('maps every request error code to its dedicated message', () => {
    const t = en.t as TFunction<['common', 'conversation', 'errors']>
    expect(
      translateConversationStatus(t, {
        kind: 'requestError',
        operation: 'load',
        error: { code: 'NOT_FOUND', resource: 'conversation' }
      })
    ).toBe("This conversation doesn't exist or has been deleted.")
    expect(
      translateConversationStatus(t, {
        kind: 'requestError',
        operation: 'load',
        error: { code: 'NOT_FOUND', resource: 'message' }
      })
    ).toBe("This message doesn't exist or has been deleted.")
    expect(
      translateConversationStatus(t, {
        kind: 'requestError',
        operation: 'cancel',
        error: { code: 'REQUEST_NOT_FOUND' }
      })
    ).toBe('No active reply request was found.')
  })

  it('distinguishes IPC rejections by operation', () => {
    const t = zh.t as TFunction<['common', 'conversation', 'errors']>
    expect(translateConversationStatus(t, { kind: 'ipcError', operation: 'send' })).toBe(
      '无法发送消息，请稍后重试。'
    )
    expect(translateConversationStatus(t, { kind: 'ipcError', operation: 'list' })).toBe(
      '无法刷新会话列表，请稍后重试。'
    )
  })

  it('translates generation failures by error code', () => {
    const t = zh.t as TFunction<['common', 'conversation', 'errors']>
    expect(
      translateConversationStatus(t, { kind: 'generationError', error: { code: 'MODEL_ERROR' } })
    ).toBe('生成回复失败，请稍后重试。')
    expect(
      translateConversationStatus(t, {
        kind: 'generationError',
        error: { code: 'PERSISTENCE_ERROR' }
      })
    ).toBe('保存会话失败，请稍后重试。')
    expect(
      translateConversationStatus(t, {
        kind: 'generationError',
        error: { code: 'TOOL_CALL_NOT_SUPPORTED' }
      })
    ).toBe('当前模型或接口不支持词汇保存所需的工具调用，请更换模型或接口后重试。')
  })
})
