import type { VocabularyMistakesErrorCode } from '../../../../shared/vocabulary-mistakes'
import { COMMON_ERROR_KEY_ENTRIES, createErrorKeyResolver } from '../../i18n/error-messages'

type VocabularyMistakesErrorKey =
  (typeof COMMON_ERROR_KEY_ENTRIES)[keyof typeof COMMON_ERROR_KEY_ENTRIES]

// 穷尽的显式映射，不使用任意字符串断言绕过 key 校验；错题查询错误码
// 全部走公共条目。
const VOCABULARY_MISTAKES_ERROR_KEYS: Record<
  VocabularyMistakesErrorCode,
  VocabularyMistakesErrorKey
> = {
  ...COMMON_ERROR_KEY_ENTRIES
}

const resolveVocabularyMistakesErrorKey = createErrorKeyResolver(COMMON_ERROR_KEY_ENTRIES)

export function vocabularyMistakesErrorKey(
  code: VocabularyMistakesErrorCode
): VocabularyMistakesErrorKey {
  return resolveVocabularyMistakesErrorKey(VOCABULARY_MISTAKES_ERROR_KEYS, code)
}

// 列表 hook 以 unknown 透传抛出的错误码；收窄回领域码，未知值按 UNKNOWN_ERROR。
export function toVocabularyMistakesError(error: unknown): VocabularyMistakesErrorCode {
  return typeof error === 'string' && error in VOCABULARY_MISTAKES_ERROR_KEYS
    ? (error as VocabularyMistakesErrorCode)
    : 'UNKNOWN_ERROR'
}
