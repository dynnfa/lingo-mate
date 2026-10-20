import { createInstance } from 'i18next'
import type { SupportedLocale } from '../shared/preferences'
import type { ChatChannelReplies } from '../core/channels/channel-types'
import chatChannelsEn from '../shared/locales/en/chat-channels.json'
import chatChannelsZhCN from '../shared/locales/zh-CN/chat-channels.json'

// 平台回复文案由 Main 持有的 i18n 资源驱动；语言取每次回复时的
// 界面语言快照，覆盖项目支持的全部语言。
export function createChatChannelReplies(): ChatChannelReplies {
  const instance = createInstance()
  void instance.init({
    lng: 'zh-CN',
    fallbackLng: 'zh-CN',
    supportedLngs: ['zh-CN', 'en'],
    defaultNS: 'chat-channels',
    resources: {
      'zh-CN': { 'chat-channels': chatChannelsZhCN },
      en: { 'chat-channels': chatChannelsEn }
    },
    interpolation: { escapeValue: false }
  })
  const t = (
    key: string,
    language: SupportedLocale,
    options: Record<string, unknown> = {}
  ): string => instance.t(key, { ...options, lng: language })

  const plain =
    (key: string) =>
    (language: SupportedLocale): string =>
      t(`replies.${key}`, language)
  const listFormat = new Map<SupportedLocale, Intl.ListFormat>([
    ['zh-CN', new Intl.ListFormat('zh-CN')],
    ['en', new Intl.ListFormat('en')]
  ])
  const formatWords = (language: SupportedLocale, words: string[]): string =>
    (listFormat.get(language) ?? listFormat.get('zh-CN')!).format(words)

  return {
    help: plain('help'),
    notBound: plain('notBound'),
    alreadyBound: plain('alreadyBound'),
    bindingRequested: plain('bindingRequested'),
    bindingCodeMismatch: plain('bindingCodeMismatch'),
    bindingCodeExpired: plain('bindingCodeExpired'),
    bindingCodeExhausted: plain('bindingCodeExhausted'),
    noActiveBindingCode: plain('noActiveBindingCode'),
    confirmationPrompt: (language, detail) =>
      t('replies.confirmationPrompt', language, {
        words: formatWords(language, detail.words),
        targetLanguage: detail.targetLanguage,
        operationId: detail.operationId
      }),
    confirmNoPending: plain('confirmNoPending'),
    confirmLanguageChanged: (language, detail) =>
      t('replies.confirmLanguageChanged', language, {
        words: formatWords(language, detail.words),
        targetLanguage: detail.targetLanguage,
        operationId: detail.operationId
      }),
    confirmExpired: plain('confirmExpired'),
    intentClarify: plain('intentClarify'),
    cancelReport: (language, detail) =>
      t('replies.cancelReport', language, { cancelled: detail.cancelled }),
    cancelIdle: plain('cancelIdle'),
    newSessionBusy: plain('newSessionBusy'),
    newSessionStarted: plain('newSessionStarted'),
    queueBusy: plain('queueBusy'),
    rateLimited: plain('rateLimited'),
    messageTooLong: plain('messageTooLong'),
    executionFailed: plain('executionFailed'),
    needsAttention: plain('needsAttention')
  }
}
