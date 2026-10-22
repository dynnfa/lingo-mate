import { randomUUID } from 'node:crypto'
import { vi } from 'vitest'
import { SynonymHost } from '../../../src/core/learning/synonym/synonym-host'
import type { SynonymAnalyzer } from '../../../src/core/learning/synonym/synonym-analyzer'
import type { SynonymRepository } from '../../../src/core/learning/synonym/synonym-repository'
import type { SynonymBatch, SynonymEntry, SynonymGroup } from '../../../src/shared/synonym'
import type { ConversationSkillRunInput } from '../../../src/core/conversation/conversation-skill'

export const synonymDecision: SynonymAnalyzer['analyze'] = async ({ messages }) => {
  const word = JSON.parse(String(messages[1].content)).word as string
  const page =
    messages.at(-1)?.role === 'tool'
      ? (JSON.parse(String(messages.at(-1)!.content)) as { groups: SynonymGroup[] })
      : undefined
  const groupid = page?.groups[0]?.id
  return {
    canCorrectParallel: false,
    message: {
      reasoning_content: 'private-provider-thought',
      tool_calls: [
        {
          id: randomUUID(),
          type: 'function',
          function: {
            name: !page
              ? 'find_synonym_groups'
              : groupid
                ? 'add_synonym_to_group'
                : 'create_synonym_group_and_add_word',
            arguments: JSON.stringify({
              word,
              meaning: 'private-gloss',
              ...(!page
                ? {}
                : {
                    distinction: 'private-distinction',
                    ...(groupid ? { groupid } : { groupMeaning: 'private-group-meaning' })
                  })
            })
          }
        }
      ]
    }
  }
}

export function synonymFixture(text = 'adequate,decent'): {
  entries: SynonymEntry[]
  reports: SynonymBatch[]
  groups: SynonymGroup[]
  repository: SynonymRepository
  input: ConversationSkillRunInput
  createAnalyzer: ReturnType<typeof vi.fn<() => SynonymAnalyzer>>
  host: SynonymHost
} {
  const entries: SynonymEntry[] = []
  const reports: SynonymBatch[] = []
  const groups: SynonymGroup[] = []
  const repository: SynonymRepository = {
    findExisting: (words) =>
      new Map(entries.filter((e) => words.includes(e.word)).map((e) => [e.word, e])),
    findGroups: () => ({ groups: structuredClone(groups), nextCursor: null }),
    listGroups: () => ({ groups: structuredClone(groups), nextCursor: null }),
    saveReport: (_id, report) => {
      reports.push(structuredClone(report))
    },
    saveWord: (_id, content, finalize) => {
      const entry: SynonymEntry = {
        id: randomUUID(),
        word: content.word,
        meaning: content.meaning,
        distinction: content.distinction,
        groupid: 'groupid' in content ? content.groupid : randomUUID()
      }
      const result = { status: 'saved' as const, entry }
      const report = finalize(result)
      if ('groupMeaning' in content)
        groups.push({ id: entry.groupid, meaning: content.groupMeaning, words: [] })
      entries.push(entry)
      groups.find((g) => g.id === entry.groupid)!.words.push(entry)
      reports.push(structuredClone(report))
      return result
    }
  }
  const input: ConversationSkillRunInput = {
    requestId: randomUUID(),
    executionId: randomUUID(),
    sessionId: randomUUID(),
    userMessageId: randomUUID(),
    arguments: { text, wordLanguage: 'en' },
    explanationLanguage: 'en',
    signal: new AbortController().signal,
    onPhase: vi.fn()
  }
  const createAnalyzer = vi.fn(() => ({ analyze: synonymDecision }))
  return {
    entries,
    reports,
    groups,
    repository,
    input,
    createAnalyzer,
    host: new SynonymHost(repository, createAnalyzer, input)
  }
}
