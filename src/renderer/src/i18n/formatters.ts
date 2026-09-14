import type { SupportedLocale } from '../../../shared/preferences'

// 所有面向用户的日期/时间格式化都必须显式携带当前界面 locale，
// 不依赖宿主环境默认值；存储中的 ISO 字符串保持原样。
export function formatDateTime(locale: SupportedLocale, isoDateTime: string): string {
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(
    new Date(isoDateTime)
  )
}

// 列表分隔符随界面 locale 选择，避免在组件里硬编码全角标点。
export function listSeparator(locale: SupportedLocale): string {
  return locale === 'en' ? '; ' : '；'
}
