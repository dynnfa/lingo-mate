// /explore-vocabulary 的统一规范化规则：Unicode NFKC、弯撇号折叠为 ASCII
// 撇号、首尾去空白、连续空白折叠、英语小写。去重键与应用保存的
// normalizedTerm 都使用该函数计算；首版不做语义相似度去重或词形归并。

const CURLY_APOSTROPHES = /[\u2018\u2019\u02BC]/gu

export function normalizeExploreVocabularyTerm(term: string): string {
  return term
    .normalize('NFKC')
    .replace(CURLY_APOSTROPHES, "'")
    .trim()
    .replace(/\s+/gu, ' ')
    .toLowerCase()
}

// 单词词形：字母段之间允许单个连字符或撇号连接（例如 well-known、don't），
// 拒绝多词短语、数字与纯标点。词法符合不等于真实英语单词，常用程度由
// Prompt 与内容抽样验收约束；本规则在 normalizeExploreVocabularyTerm 结果
// 上判定。
const TERM_SHAPE_PATTERN = /^[a-z]+(?:[-'][a-z]+)*$/u

export function isExploreVocabularyTermShape(normalizedTerm: string): boolean {
  return TERM_SHAPE_PATTERN.test(normalizedTerm)
}

// 例句包含完整单词的检查：两侧先做同规则规范化（大小写、弯撇号与空白差异
// 视为相同），再按词边界匹配。连字符与撇号也是词内字符，避免 art 命中
// party、learn 命中 learned、well 命中 well-known 的片段误报；词形不同
// （learn 与 learned）视为不同单词。
export function exploreVocabularyExampleContainsTerm(example: string, term: string): boolean {
  const haystack = example
    .normalize('NFKC')
    .replace(CURLY_APOSTROPHES, "'")
    .replace(/\s+/gu, ' ')
    .toLowerCase()
  const needle = normalizeExploreVocabularyTerm(term)
  if (!needle) return false
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
  return new RegExp(`(?<![\\p{L}\\p{N}'-])${escaped}(?![\\p{L}\\p{N}'-])`, 'u').test(haystack)
}
