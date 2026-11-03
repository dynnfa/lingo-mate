import { createInstance } from 'i18next'
import en from '../../shared/locales/en/communication.json'
import zh from '../../shared/locales/zh-CN/communication.json'
import type { SupportedLocale } from '../../shared/preferences'
import type { ConversationEvent } from '../../shared/conversation'
import type { BusinessResult } from './business-port'
const i18n = createInstance()
void i18n.init({
  resources: { en: { communication: en }, 'zh-CN': { communication: zh } },
  defaultNS: 'communication',
  lng: 'en',
  interpolation: { escapeValue: false }
})
export function message(
  key: { [K in keyof typeof en]: (typeof en)[K] extends string ? K : never }[keyof typeof en],
  language: SupportedLocale,
  values?: Record<string, string>
): string {
  return i18n.t(key, { lng: language, ...values }) as string
}
// Only committed final events. Reasoning, tools, errors and temporary chunks never project.
export function projectResult(event: ConversationEvent): BusinessResult | undefined {
  if (event.type === 'completed' && !event.message.speech)
    return { status: 'succeeded', text: event.message.content }
  if (event.type === 'cancelled') return { status: 'cancelled' }
  if (event.type === 'failed') return { status: 'failed' }
  return undefined
}
