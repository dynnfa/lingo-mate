import { z } from 'zod'
import type { ChatCompletionTool } from 'openai/resources/chat/completions'
import { synonymTextSchema, synonymWordSchema } from '../../../shared/synonym'
import type { SynonymRepository, SynonymSaveResult, SynonymWrite } from './synonym-repository'
import { SynonymError } from './parse-synonym-input'

const word = synonymWordSchema
const meaning = synonymTextSchema
const distinction = synonymTextSchema
export const synonymToolSchemas = {
  find_synonym_groups: z.strictObject({ word, meaning, cursor: z.uuid().optional() }),
  add_synonym_to_group: z.strictObject({ word, meaning, groupid: z.uuid(), distinction }),
  create_synonym_group_and_add_word: z.strictObject({
    groupMeaning: meaning,
    word,
    meaning,
    distinction
  }),
  report_unrecognized_word: z.strictObject({ word })
}
export function synonymTools(): ChatCompletionTool[] {
  return Object.entries(synonymToolSchemas).map(([name, schema]) => ({
    type: 'function',
    function: { name, parameters: z.toJSONSchema(schema, { unrepresentable: 'any' }) }
  }))
}

// State is per word. Only database facts actually returned by this executor authorize a write.
export class SynonymToolExecutor {
  private queried = false
  private nextCursor: string | null | undefined
  private readonly seen = new Set<string>()
  private pages = 0
  private terminal = false
  constructor(
    private readonly word: string,
    private readonly repository: SynonymRepository,
    private readonly save: (content: SynonymWrite) => SynonymSaveResult,
    private readonly signal: AbortSignal,
    private readonly maxPages = 50
  ) {}
  get completed(): boolean {
    return this.terminal
  }
  execute(name: string, raw: unknown): { terminal: boolean; result: unknown } {
    if (this.signal.aborted) throw new SynonymError('CANCELLED')
    if (this.terminal) throw new SynonymError('INVALID_ANALYSIS')
    const schema = Object.hasOwn(synonymToolSchemas, name)
      ? synonymToolSchemas[name as keyof typeof synonymToolSchemas]
      : undefined
    const parsed = schema?.safeParse(raw)
    if (!parsed?.success || parsed.data.word !== this.word)
      throw new SynonymError('INVALID_ANALYSIS')
    const args = parsed.data
    if (name === 'report_unrecognized_word') {
      this.terminal = true
      return { terminal: true, result: { status: 'unrecognized' } }
    }
    if (name === 'find_synonym_groups') {
      const query = synonymToolSchemas.find_synonym_groups.parse(args)
      if (this.queried && (!this.nextCursor || query.cursor !== this.nextCursor))
        throw new SynonymError('INVALID_ANALYSIS')
      if (!this.queried && query.cursor !== undefined) throw new SynonymError('INVALID_ANALYSIS')
      if (++this.pages > this.maxPages) throw new SynonymError('SCAN_LIMIT')
      const page = this.repository.findGroups(query.cursor)
      this.queried = true
      this.nextCursor = page.nextCursor
      page.groups.forEach((group) => this.seen.add(group.id))
      return { terminal: false, result: page }
    }
    if (!this.queried) throw new SynonymError('INVALID_ANALYSIS')
    let content: SynonymWrite
    if (name === 'add_synonym_to_group') {
      content = synonymToolSchemas.add_synonym_to_group.parse(args)
      if (!this.seen.has(content.groupid)) throw new SynonymError('INVALID_ANALYSIS')
    } else {
      if (this.nextCursor !== null) throw new SynonymError('INVALID_ANALYSIS')
      content = synonymToolSchemas.create_synonym_group_and_add_word.parse(args)
    }
    const saved = this.save(content)
    this.terminal = true
    return {
      terminal: true,
      result: { ...saved, status: saved.status === 'existing' ? 'skipped_existing' : 'saved' }
    }
  }
}
