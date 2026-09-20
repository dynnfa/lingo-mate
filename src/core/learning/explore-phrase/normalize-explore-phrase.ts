// /explore-phrase 的统一规范化规则：Unicode NFKC、首尾去空白、连续空白折叠、
// 英语小写。去重键与应用保存的 normalizedPhrase 都使用该函数计算；
// 首版不做语义相似度去重或词形归并。

export function normalizeExplorePhrase(phrase: string): string {
  return phrase.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLowerCase()
}

// 例句包含完整短语的检查：两侧先做同规则规范化（大小写与空白差异视为相同），
// 再按词边界匹配，避免 "look forward" 命中 "looking forward" 这类前缀误报。
export function explorePhraseExampleContainsPhrase(example: string, phrase: string): boolean {
  const haystack = example.normalize('NFKC').replace(/\s+/gu, ' ').toLowerCase()
  const needle = normalizeExplorePhrase(phrase)
  if (!needle) return false
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
  return new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, 'u').test(haystack)
}
