import { randomUUID } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { SynonymToolExecutor, synonymTools } from '../synonym-tools'
import type { SynonymRepository } from '../../learning/synonym/synonym-repository'

function setup(
  pages = [{ groups: [], nextCursor: null }] as ReturnType<SynonymRepository['findGroups']>[]
): { executor: SynonymToolExecutor; save: ReturnType<typeof vi.fn>; controller: AbortController } {
  const repository: SynonymRepository = {
    findExisting: vi.fn(),
    findGroups: vi.fn(() => pages.shift()!),
    saveWord: vi.fn(),
    saveReport: vi.fn()
  }
  const save = vi.fn(() => ({
    status: 'saved' as const,
    entry: {
      id: randomUUID(),
      word: 'decent',
      meaning: 'okay',
      distinction: 'informal',
      groupid: randomUUID()
    }
  }))
  const controller = new AbortController()
  return {
    executor: new SynonymToolExecutor('decent', repository, save, controller.signal, 2),
    save,
    controller
  }
}
const query = { word: 'decent', meaning: 'okay' }
const create = { ...query, groupMeaning: 'okay', distinction: 'informal' }
describe('synonym tools', () => {
  it('defines exactly four strict tools', () => {
    expect(synonymTools()).toHaveLength(4)
    for (const tool of synonymTools())
      if (tool.type === 'function')
        expect(tool.function.parameters?.additionalProperties).toBe(false)
  })
  it.each([
    ['create_synonym_group_and_add_word', create],
    ['add_synonym_to_group', { ...query, distinction: 'informal', groupid: randomUUID() }],
    ['find_synonym_groups', { ...query, word: 'other' }],
    ['find_synonym_groups', { ...query, sql: 'DROP TABLE synonym' }],
    ['find_synonym_groups', { ...query, meaning: ' ' }],
    ['unknown', query]
  ])('rejects unauthorized %s', (name, args) => {
    const { executor, save } = setup()
    expect(() => executor.execute(name, args)).toThrow()
    expect(save).not.toHaveBeenCalled()
  })
  it('requires complete pagination for creation and rejects forged group ids', () => {
    const cursor = randomUUID()
    const { executor, save } = setup([
      { groups: [], nextCursor: cursor },
      { groups: [], nextCursor: null }
    ])
    executor.execute('find_synonym_groups', query)
    expect(() => executor.execute('create_synonym_group_and_add_word', create)).toThrow()
    expect(() =>
      executor.execute('add_synonym_to_group', {
        ...query,
        groupid: randomUUID(),
        distinction: 'informal'
      })
    ).toThrow()
    expect(() =>
      executor.execute('find_synonym_groups', { ...query, cursor: randomUUID() })
    ).toThrow()
    executor.execute('find_synonym_groups', { ...query, cursor })
    expect(executor.execute('create_synonym_group_and_add_word', create).terminal).toBe(true)
    expect(save).toHaveBeenCalledOnce()
    expect(() => executor.execute('create_synonym_group_and_add_word', create)).toThrow()
  })
  it('can join only an observed group and checks abort before writing', () => {
    const id = randomUUID()
    const { executor, controller, save } = setup([
      { groups: [{ id, meaning: 'okay', words: [] }], nextCursor: null }
    ])
    executor.execute('find_synonym_groups', query)
    controller.abort()
    expect(() =>
      executor.execute('add_synonym_to_group', { ...query, groupid: id, distinction: 'informal' })
    ).toThrow()
    expect(save).not.toHaveBeenCalled()
  })
  it('fails when the scan budget is exhausted', () => {
    const cursor = randomUUID()
    const { executor } = setup([
      { groups: [], nextCursor: cursor },
      { groups: [], nextCursor: cursor }
    ])
    executor.execute('find_synonym_groups', query)
    executor.execute('find_synonym_groups', { ...query, cursor })
    expect(() => executor.execute('find_synonym_groups', { ...query, cursor })).toThrow(
      /SCAN_LIMIT/
    )
  })
})
