import vocabularyEn from './locales/en/vocabulary.json'
import vocabularyZhCN from './locales/zh-CN/vocabulary.json'
import { createInstance, type i18n as I18nextInstance, type Resource } from 'i18next'
import { initReactI18next } from 'react-i18next'
import { SUPPORTED_LOCALES, type SupportedLocale } from '../../../shared/preferences'
import commonEn from './locales/en/common.json'
import conversationEn from './locales/en/conversation.json'
import errorsEn from './locales/en/errors.json'
import commonZhCN from './locales/zh-CN/common.json'
import conversationZhCN from './locales/zh-CN/conversation.json'
import errorsZhCN from './locales/zh-CN/errors.json'

export const FALLBACK_LOCALE = 'zh-CN'
export const I18N_NAMESPACES = ['common', 'conversation', 'errors', 'vocabulary'] as const

// 资源静态打包进渲染进程；不引入 HTTP backend 或语言探测插件，
// 界面语言统一由 Main 解析后传入，避免浏览器与桌面偏好形成两套来源。
export const bundledResources = {
  'zh-CN': {
    vocabulary: vocabularyZhCN,
    common: commonZhCN,
    conversation: conversationZhCN,
    errors: errorsZhCN
  },
  en: {
    vocabulary: vocabularyEn,
    common: commonEn,
    conversation: conversationEn,
    errors: errorsEn
  }
} satisfies Resource

export function isSupportedI18nLocale(value: unknown): value is SupportedLocale {
  return typeof value === 'string' && (SUPPORTED_LOCALES as readonly string[]).includes(value)
}

export function normalizeI18nLocale(value: unknown): SupportedLocale {
  return isSupportedI18nLocale(value) ? value : FALLBACK_LOCALE
}

// 独立实例工厂：应用启动与测试各自持有实例，避免共享语言状态污染用例。
export function createI18n(locale: SupportedLocale = FALLBACK_LOCALE): I18nextInstance {
  const instance = createInstance()
  void instance.use(initReactI18next).init({
    lng: locale,
    fallbackLng: FALLBACK_LOCALE,
    supportedLngs: SUPPORTED_LOCALES,
    resources: bundledResources,
    defaultNS: 'common',
    ns: I18N_NAMESPACES,
    // React 以文本节点渲染插值，转义交给 React 而不是 i18next。
    interpolation: { escapeValue: false },
    react: { bindI18n: 'languageChanged loaded' }
  })
  return instance
}

export function applyDocumentLanguage(locale: SupportedLocale): void {
  document.documentElement.lang = locale
  document.documentElement.dir = 'ltr'
}
