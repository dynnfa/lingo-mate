const LANGUAGE_NAMES: Record<string, string> = {
  'zh-CN': 'Simplified Chinese',
  en: 'English'
}

// 语言占位符的统一展开方式，供各 prompt 组装方保持一致命名。
export function languageName(language: string): string {
  return `${LANGUAGE_NAMES[language] ?? language} (${language})`
}
