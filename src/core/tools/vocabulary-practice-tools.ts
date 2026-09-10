import { z } from 'zod'
import type { ChatCompletionTool } from 'openai/resources/chat/completions'
import {
  VOCABULARY_PRACTICE_COUNT_MAX,
  VOCABULARY_PRACTICE_MARK_REASON_MAX_LENGTH
} from '../../shared/vocabulary-practice'
import { VocabularyPracticeError } from '../learning/vocabulary-practice/parse-vocabulary-practice-input'

// 标红工具：模型只能引用本轮快照内的词条并标记 meaning 字段；
// reason 是给用户看的错误原因，不携带样式、选择器或脚本。
export const markTextRedSchema = z.strictObject({
  items: z
    .array(
      z.strictObject({
        entryId: z.uuid(),
        field: z.literal('meaning'),
        reason: z.string().trim().min(1).max(VOCABULARY_PRACTICE_MARK_REASON_MAX_LENGTH)
      })
    )
    .min(1)
    .max(VOCABULARY_PRACTICE_COUNT_MAX)
})

export function vocabularyPracticeTools(): ChatCompletionTool[] {
  return [
    {
      type: 'function',
      function: {
        name: 'mark_text_red',
        parameters: z.toJSONSchema(markTextRedSchema, { unrepresentable: 'any' })
      }
    }
  ]
}

export type MarkTextRedOutcome =
  | { ok: true; result: { status: 'marked'; markedCount: number } }
  | { ok: false; error: 'UNKNOWN_TOOL' | 'INVALID_ARGUMENTS' | 'UNKNOWN_ENTRY_ID' }

// 标红工具执行器：ID 必须属于当前审查快照，越界或非法参数不执行；
// 同一字段重复标记幂等（保留首次原因）。
export class VocabularyPracticeToolExecutor {
  private readonly marks = new Map<string, { entryId: string; field: 'meaning'; reason: string }>()

  constructor(
    private readonly entryIds: ReadonlySet<string>,
    private readonly signal: AbortSignal
  ) {}

  get marked(): Array<{ entryId: string; field: 'meaning'; reason: string }> {
    return [...this.marks.values()]
  }

  execute(name: string, raw: unknown): MarkTextRedOutcome {
    if (this.signal.aborted) throw new VocabularyPracticeError('CANCELLED')
    if (name !== 'mark_text_red') return { ok: false, error: 'UNKNOWN_TOOL' }
    const parsed = markTextRedSchema.safeParse(raw)
    if (!parsed.success) return { ok: false, error: 'INVALID_ARGUMENTS' }
    // 先整体校验再应用：任何越界 ID 都让本次调用完全不生效。
    if (parsed.data.items.some((item) => !this.entryIds.has(item.entryId)))
      return { ok: false, error: 'UNKNOWN_ENTRY_ID' }
    for (const item of parsed.data.items) {
      const key = `${item.entryId}:${item.field}`
      if (!this.marks.has(key)) this.marks.set(key, item)
    }
    return { ok: true, result: { status: 'marked', markedCount: this.marks.size } }
  }
}
