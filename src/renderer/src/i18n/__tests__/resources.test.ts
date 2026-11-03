import communicationEn from '../../../../shared/locales/en/communication.json'
import communicationZh from '../../../../shared/locales/zh-CN/communication.json'
import vocabularyEn from '../../../../shared/locales/en/vocabulary.json'
import speechEn from '../../../../shared/locales/en/speech.json'
import speechZhCN from '../../../../shared/locales/zh-CN/speech.json'
import vocabularyZhCN from '../../../../shared/locales/zh-CN/vocabulary.json'
import { describe, expect, it } from 'vitest'
import { SUPPORTED_LOCALES } from '../../../../shared/preferences'
import { createI18n, I18N_NAMESPACES } from '../index'
import commonEn from '../locales/en/common.json'
import conversationEn from '../locales/en/conversation.json'
import errorsEn from '../locales/en/errors.json'
import commonZhCN from '../locales/zh-CN/common.json'
import conversationZhCN from '../locales/zh-CN/conversation.json'
import errorsZhCN from '../locales/zh-CN/errors.json'

const NAMESPACED_RESOURCES = {
  'zh-CN': {
    communication: communicationZh,
    speech: speechZhCN,
    vocabulary: vocabularyZhCN,
    common: commonZhCN,
    conversation: conversationZhCN,
    errors: errorsZhCN
  },
  en: {
    communication: communicationEn,
    speech: speechEn,
    vocabulary: vocabularyEn,
    common: commonEn,
    conversation: conversationEn,
    errors: errorsEn
  }
} as const

function flattenKeys(value: unknown, prefix = ''): string[] {
  if (typeof value !== 'object' || value === null) {
    return prefix ? [prefix] : []
  }
  return Object.entries(value).flatMap(([key, nested]) =>
    flattenKeys(nested, prefix ? `${prefix}.${key}` : key)
  )
}

function placeholders(template: unknown): string[] {
  return typeof template === 'string'
    ? [...template.matchAll(/\{\{\s*([\w.]+)\s*\}\}/g)].map((match) => match[1]).sort()
    : []
}

function templateAt(resources: Record<string, unknown>, key: string): unknown {
  return key.split('.').reduce<unknown>((node, segment) => {
    if (typeof node === 'object' && node !== null && segment in node) {
      return (node as Record<string, unknown>)[segment]
    }
    return undefined
  }, resources)
}

describe('i18n bundled resources', () => {
  it.each(SUPPORTED_LOCALES)('ships a non-empty translation for every key in %s', (locale) => {
    for (const namespace of I18N_NAMESPACES) {
      const resources = NAMESPACED_RESOURCES[locale][namespace]
      for (const key of flattenKeys(resources)) {
        const template = templateAt(resources, key)
        expect(template, `${locale}/${namespace}:${key}`).toBeTypeOf('string')
        expect(String(template).trim(), `${locale}/${namespace}:${key}`).not.toBe('')
      }
    }
  })

  it('keeps the zh-CN and en key sets identical so missing keys cannot hide behind fallback', () => {
    for (const namespace of I18N_NAMESPACES) {
      const zhKeys = flattenKeys(NAMESPACED_RESOURCES['zh-CN'][namespace]).sort()
      const enKeys = flattenKeys(NAMESPACED_RESOURCES.en[namespace]).sort()
      expect(enKeys, `namespace ${namespace}`).toEqual(zhKeys)
    }
  })

  it('keeps interpolation placeholders consistent across locales', () => {
    for (const namespace of I18N_NAMESPACES) {
      const zhResources = NAMESPACED_RESOURCES['zh-CN'][namespace]
      const enResources = NAMESPACED_RESOURCES.en[namespace]
      for (const key of flattenKeys(zhResources)) {
        expect(
          placeholders(templateAt(enResources, key)),
          `placeholders for ${namespace}:${key}`
        ).toEqual(placeholders(templateAt(zhResources, key)))
      }
    }
  })
})

describe('i18next instance', () => {
  it('translates a shared key in both locales with the bundled resources', async () => {
    const zh = createI18n('zh-CN')
    expect(zh.t('conversation:status.ready')).toBe('准备就绪')

    const en = createI18n('en')
    expect(en.t('conversation:status.ready')).toBe('Ready')
  })

  it('interpolates named placeholders from the full translated template', () => {
    const zh = createI18n('zh-CN')
    expect(zh.t('conversation:listItemLabel', { dateTime: '2026年9月2日 18:00' })).toBe(
      '会话 · 2026年9月2日 18:00'
    )

    const en = createI18n('en')
    expect(en.t('conversation:listItemLabel', { dateTime: 'Sep 2, 2026, 6:00 PM' })).toBe(
      'Conversation · Sep 2, 2026, 6:00 PM'
    )
  })

  it('falls back to zh-CN when the active language is missing a value', () => {
    const instance = createI18n('zh-CN')
    expect(instance.t('common:app.title')).toBe('语言学习助手')
  })

  it('returns the key itself for an unknown language requested at runtime', () => {
    const instance = createI18n('zh-CN')
    expect(instance.t('common:app.title', { lng: 'fr' })).toBe('语言学习助手')
  })
})
