import { afterEach, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { openDatabase } from '../../src/database/database'
import { SqliteVocabularyRepository } from '../../src/database/sqlite-vocabulary-repository'
import { VocabularyTransferService } from '../../src/core/learning/vocabulary/vocabulary-transfer'
import {
  content,
  insertCommand,
  insertResult
} from '../../src/core/learning/vocabulary/__tests__/fixtures'
import { decodeVocabularyExcel, encodeVocabularyExcel } from '../../src/main/vocabulary-excel'
const databases: ReturnType<typeof openDatabase>[] = []
afterEach(() => {
  for (const db of databases.splice(0)) db.close()
})
function setup(): {
  database: ReturnType<typeof openDatabase>
  repository: SqliteVocabularyRepository
  service: VocabularyTransferService
} {
  const database = openDatabase(':memory:')
  databases.push(database)
  const repository = new SqliteVocabularyRepository(database)
  const service = new VocabularyTransferService(repository, () => ({
    analyze: vi.fn(async ({ term }) => insertResult(term))
  }))
  return { database, repository, service }
}
it('round-trips complete exported content, skips existing rows and preserves legacy NULLs as validation errors', async () => {
  const { database, repository, service } = setup()
  repository.saveBatch([insertCommand('apple')])
  const exported = await encodeVocabularyExcel(repository.exportAll(), 'en')
  const preview = service.preview(1, await decodeVocabularyExcel(exported))
  expect(preview).toMatchObject({ valid: 1, existing: 1, issues: [] })
  expect(service.confirm(1, preview.importId).counts.saved).toBe(0)
  database
    .prepare(
      'UPDATE vocabulary SET phonetic = NULL, meaning = NULL, concept = NULL, example_sentences = NULL'
    )
    .run()
  const old = service.preview(
    1,
    await decodeVocabularyExcel(await encodeVocabularyExcel(repository.exportAll(), 'en'))
  )
  expect(old.issues.map((issue) => issue.field)).toEqual(
    expect.arrayContaining(['phonetic', 'meaning', 'concept', 'example_sentence_1'])
  )
  expect(() => service.confirm(1, old.importId)).toThrow()
})
it('rolls back the entire direct import if any INSERT fails and returns the same failed confirmation', async () => {
  const { database, repository, service } = setup()
  database.exec(
    "CREATE TRIGGER reject_banana BEFORE INSERT ON vocabulary WHEN NEW.term = 'banana' BEGIN SELECT RAISE(ABORT, 'test failure'); END;"
  )
  const preview = service.preview(
    1,
    await decodeVocabularyExcel(
      await encodeVocabularyExcel([content('apple'), content('banana')], 'en')
    )
  )
  const result = service.confirm(1, preview.importId)
  expect(result).toMatchObject({ phase: 'failed', counts: { saved: 0, failed: 2 } })
  expect(repository.exportAll()).toEqual([])
  expect(service.confirm(1, preview.importId)).toEqual(result)
})
it('rechecks concurrent inserts during AI commit without overwriting content', async () => {
  const { repository } = setup()
  const original = insertCommand('apple')
  const service = new VocabularyTransferService(repository, () => ({
    analyze: vi.fn(async () => {
      repository.saveBatch([original])
      const result = insertResult('apple')
      if (result.status === 'insert') result.content.meaning = 'different content'
      return result
    })
  }))
  service.start(1, { requestId: randomUUID(), text: 'apple' }, 'en')
  await vi.waitFor(() => expect(service.getTask(1)?.phase).toBe('completed'))
  expect(service.getTask(1)?.counts).toMatchObject({ existing: 1, saved: 0 })
  expect(repository.exportAll()[0].meaning).toBe(original.parameters.meaning)
})

it('round-trips accented English terms without changing their spelling', async () => {
  const { repository, service } = setup()
  const terms = ['café', 'naïve', 'cafe\u0301']
  const preview = service.preview(
    1,
    await decodeVocabularyExcel(await encodeVocabularyExcel(terms.map(content), 'en'))
  )
  expect(preview.issues).toEqual([])
  expect(preview.duplicate).toBe(1)
  expect(service.confirm(1, preview.importId).counts.saved).toBe(2)
  expect(
    repository
      .exportAll()
      .map((entry) => entry.term)
      .sort()
  ).toEqual(['café', 'naïve'])
  const exported = await encodeVocabularyExcel(repository.exportAll(), 'en')
  const again = service.preview(1, await decodeVocabularyExcel(exported))
  expect(again).toMatchObject({ valid: 2, existing: 2, issues: [] })
})
