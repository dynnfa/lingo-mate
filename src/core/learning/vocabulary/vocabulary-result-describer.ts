import type { SupportedLocale } from '../../../shared/preferences'
import type { VocabularyBatch } from '../../../shared/vocabulary'

export interface DescribeVocabularyResultInput {
  batch: VocabularyBatch
  explanationLanguage: SupportedLocale
  signal: AbortSignal
}

export interface VocabularyResultDescriber {
  describe(input: DescribeVocabularyResultInput): Promise<string>
}

export function vocabularyResultFacts(batch: VocabularyBatch): object {
  return {
    counts: batch.counts,
    saved: terms(batch, 'saved'),
    existing: terms(batch, 'existing'),
    duplicates: batch.items
      .filter((item) => item.status === 'duplicate')
      .map((item) => ({
        term: item.term,
        sourceTerm: batch.items[item.sourceInputIndex]?.term ?? item.term,
        sourceStatus: batch.items[item.sourceInputIndex]?.status ?? 'failed'
      })),
    failed: batch.items
      .filter((item) => item.status === 'failed')
      .map((item) => ({ term: item.term, code: item.code }))
  }
}

export function deterministicVocabularyFacts(
  batch: VocabularyBatch,
  language: SupportedLocale
): string {
  const saved = terms(batch, 'saved')
  const existing = terms(batch, 'existing')
  const duplicates = batch.items
    .filter((item) => item.status === 'duplicate')
    .map((item) => item.term)
  const failed = batch.items.filter((item) => item.status === 'failed').map((item) => item.term)
  const list = (values: string[]): string =>
    values.length ? values.join(language === 'zh-CN' ? '、' : ', ') : '—'
  return language === 'zh-CN'
    ? `确定性结果：新增 ${batch.counts.saved} 个（${list(saved)}）；已有 ${batch.counts.existing} 个（${list(existing)}）；输入重复 ${batch.counts.duplicate} 个（${list(duplicates)}）；失败 ${batch.counts.failed} 个（${list(failed)}）。`
    : `Verified result: ${batch.counts.saved} added (${list(saved)}); ${batch.counts.existing} existing (${list(existing)}); ${batch.counts.duplicate} duplicate in this input (${list(duplicates)}); ${batch.counts.failed} failed (${list(failed)}).`
}

function terms(batch: VocabularyBatch, status: 'saved' | 'existing'): string[] {
  return batch.items.filter((item) => item.status === status).map((item) => item.term)
}
