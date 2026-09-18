import { describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { VocabularyTransferService } from '../vocabulary-transfer'
import { VOCABULARY_COLUMNS } from '../../../../shared/vocabulary-transfer'
import { insertResult, memoryRepository } from './fixtures'
import { VocabularyError } from '../parse-vocabulary-input'
const excel = (terms: string[]): { row: number; cells: string[] }[] => [
  { row: 1, cells: [...VOCABULARY_COLUMNS] },
  ...terms.map((term, i) => ({
    row: i + 2,
    cells: [term, '/æpəl/', 'fruit', 'fruit concept', 'An apple.', '', '']
  }))
]

describe('vocabulary transfer', () => {
  it('previews without writes, skips duplicates, commits once, and binds previews to their owner', () => {
    const repository = memoryRepository()
    const analyzer = { analyze: vi.fn() }
    const service = new VocabularyTransferService(repository, () => analyzer)
    const preview = service.preview(1, excel(['apple', 'apple', 'banana']))
    expect(preview).toMatchObject({ total: 3, valid: 3, duplicate: 1, issues: [] })
    expect(repository.commands).toHaveLength(0)
    expect(() => service.confirm(2, preview.importId)).toThrow()
    const result = service.confirm(1, preview.importId)
    expect(result.counts).toEqual({ saved: 2, existing: 0, duplicate: 1, failed: 0 })
    expect(service.confirm(1, preview.importId)).toEqual(result)
    expect(repository.commands).toHaveLength(2)
    expect(repository.commands[0].parameters).toMatchObject({
      model_id: 'manual-import',
      prompt_version: 'vocabulary-excel-v1'
    })
    expect(analyzer.analyze).not.toHaveBeenCalled()
  })
})

it('analyzes sequentially, skips duplicates and existing terms, and retries only failed original rows', async () => {
  const repository = memoryRepository()
  const analyze = vi.fn(async ({ term }: { term: string }) =>
    term === 'bad' ? { status: 'unrecognized' as const } : insertResult(term)
  )
  const service = new VocabularyTransferService(repository, () => ({ analyze }))
  const id = randomUUID()
  service.start(1, { requestId: id, text: ' apple\r\n\n bad\napple' }, 'en')
  await vi.waitFor(() => expect(service.getTask(1, id)?.phase).toBe('partial'))
  expect(analyze.mock.calls.map(([input]) => input.term)).toEqual(['apple', 'bad'])
  expect(service.getTask(1, id)?.rows.map((row) => row.row)).toEqual([1, 3, 4])
  expect(repository.commands).toHaveLength(1)
  analyze.mockImplementation(async ({ term }) => insertResult(term))
  const retry = randomUUID()
  service.start(1, { requestId: retry, text: 'ignored', retryRequestId: id }, 'en')
  await vi.waitFor(() => expect(service.getTask(1, retry)?.phase).toBe('completed'))
  expect(service.getTask(1, retry)?.rows).toMatchObject([{ row: 3, term: 'bad', status: 'saved' }])
})
it('cancels an in-flight request and discards all uncommitted contents', async () => {
  const repository = memoryRepository()
  let signal: AbortSignal | undefined
  const analyze = vi
    .fn()
    .mockResolvedValueOnce(insertResult('apple'))
    .mockImplementationOnce((input) => {
      signal = input.signal
      return new Promise(() => {})
    })
  const service = new VocabularyTransferService(repository, () => ({ analyze }))
  const id = randomUUID()
  service.start(1, { requestId: id, text: 'apple\nbanana\ncherry' }, 'zh-CN')
  await vi.waitFor(() => expect(analyze).toHaveBeenCalledTimes(2))
  service.cancel(1, id)
  await vi.waitFor(() => expect(service.getTask(1, id)?.phase).toBe('cancelled'))
  expect(signal?.aborted).toBe(true)
  expect(repository.commands).toHaveLength(0)
  expect(analyze).toHaveBeenCalledTimes(2)
})

it('restores direct-import results through the same task query as AI imports', () => {
  const service = new VocabularyTransferService(memoryRepository(), () => ({ analyze: vi.fn() }))
  const preview = service.preview(1, excel(['apple']))
  const task = service.confirm(1, preview.importId)
  expect(service.getTask(1)).toEqual(task)
})
it('validates headers, text cell types, required examples and all fields before any write', () => {
  const repository = memoryRepository()
  const service = new VocabularyTransferService(repository, () => ({ analyze: vi.fn() }))
  for (const headers of [
    [...VOCABULARY_COLUMNS, 'id'],
    VOCABULARY_COLUMNS.slice(1),
    ['term', ...VOCABULARY_COLUMNS.slice(0, 6)]
  ]) {
    const rows = excel(['apple'])
    rows[0].cells = [...headers]
    const preview = service.preview(1, rows)
    expect(preview.issues).toMatchObject([{ row: 1, field: 'header', code: 'INVALID_HEADER' }])
    expect(() => service.confirm(1, preview.importId)).toThrow()
  }
  const invalid = excel(['apple', 'banana'])
  invalid[1].cells[1] = ''
  invalid[2].cells[4] = 'x'.repeat(501)
  const preview = service.preview(1, invalid)
  expect(preview.issues).toContainEqual({ row: 2, field: 'phonetic', code: 'REQUIRED' })
  expect(preview.issues).toContainEqual({
    row: 3,
    field: 'example_sentence_1',
    code: 'INVALID_VALUE'
  })
  expect(() => service.confirm(1, preview.importId)).toThrow()
  expect(repository.commands).toHaveLength(0)
})
it('maps reordered columns, ignores blank rows, retains English case and serializes optional examples in order', () => {
  const repository = memoryRepository()
  const service = new VocabularyTransferService(repository, () => ({ analyze: vi.fn() }))
  const rows = excel(['Apple'])
  rows[1].cells[6] = 'Another apple.'
  rows.forEach((row) => row.cells.reverse())
  rows.push({ row: 8, cells: ['', '', '', '', '', '', ''] })
  const preview = service.preview(1, rows)
  expect(preview.issues).toEqual([])
  service.confirm(1, preview.importId)
  expect(repository.commands[0].parameters).toMatchObject({
    term: 'Apple',
    example_sentences: JSON.stringify(['An apple.', 'Another apple.'])
  })
})
it('expires previews, bounds rows, rejects non-text fields and missing model configuration', () => {
  let time = 0
  const repository = memoryRepository()
  const service = new VocabularyTransferService(
    repository,
    () => {
      throw new Error('not configured')
    },
    () => time
  )
  const preview = service.preview(1, excel(['apple']))
  time = 16 * 60 * 1000
  expect(() => service.confirm(1, preview.importId)).toThrow('PREVIEW_EXPIRED')
  expect(() => service.preview(1, excel(Array(1001).fill('apple')))).toThrow('LIMIT_EXCEEDED')
  expect(() =>
    service.start(1, { requestId: randomUUID(), text: Array(101).fill('apple').join('\n') }, 'en')
  ).toThrow('LIMIT_EXCEEDED')
  expect(() => service.start(1, { requestId: randomUUID(), text: 'apple' }, 'en')).toThrow(
    'not configured'
  )
  const rows: { row: number; cells: unknown[] }[] = excel(['apple'])
  rows[1].cells[2] = { formula: '1+1', result: 'fruit' }
  expect(service.preview(1, rows).issues).toContainEqual({
    row: 2,
    field: 'meaning',
    code: 'INVALID_CELL'
  })
})
it('handles malformed analysis and timeouts, then continues with subsequent terms', async () => {
  vi.useFakeTimers()
  try {
    const analyze = vi
      .fn()
      .mockResolvedValueOnce({ ...insertResult(), content: { term: 'apple' } })
      .mockImplementationOnce(() => new Promise(() => {}))
      .mockResolvedValueOnce(insertResult('cherry'))
    const service = new VocabularyTransferService(memoryRepository(), () => ({ analyze }))
    service.start(1, { requestId: randomUUID(), text: 'apple\nbanana\ncherry' }, 'en')
    await vi.advanceTimersByTimeAsync(30_001)
    expect(service.getTask(1)?.rows).toMatchObject([
      { status: 'failed', code: 'INVALID_ANALYSIS' },
      { status: 'failed', code: 'TIMEOUT' },
      { status: 'saved' }
    ])
  } finally {
    vi.useRealTimers()
  }
})
it('does not duplicate starts, rejects concurrent tasks and cancels on owner release', async () => {
  const analyze = vi.fn(() => new Promise<never>(() => {}))
  const service = new VocabularyTransferService(memoryRepository(), () => ({ analyze }))
  const input = { requestId: randomUUID(), text: 'apple' }
  service.start(1, input, 'en')
  service.start(1, input, 'en')
  await vi.waitFor(() => expect(analyze).toHaveBeenCalledOnce())
  expect(() => service.start(1, { ...input, requestId: randomUUID() }, 'en')).toThrow('BUSY')
  expect(() => service.getTask(2, input.requestId)).toThrow('REQUEST_NOT_FOUND')
  service.release(1)
  await Promise.resolve()
  expect(service.getTask(1)).toBeNull()
})

it('reports already-resolved rows while analysis is in progress and cannot cancel a synchronous commit', async () => {
  const repository = memoryRepository()
  const first = new VocabularyTransferService(repository, () => ({ analyze: vi.fn() }))
  first.confirm(1, first.preview(1, excel(['apple'])).importId)
  let release: (value: ReturnType<typeof insertResult>) => void = () => {}
  const service = new VocabularyTransferService(repository, () => ({
    analyze: () =>
      new Promise((resolve) => {
        release = resolve
      })
  }))
  const id = randomUUID()
  const initial = service.start(
    2,
    { requestId: id, text: 'apple\nbanana\napple' },
    'en',
    (task) => {
      if (task.phase === 'committing') service.cancel(2, id)
    }
  )
  expect(initial).toMatchObject({ processed: 2, counts: { existing: 1, duplicate: 1 } })
  await Promise.resolve()
  release(insertResult('banana'))
  await vi.waitFor(() => expect(service.getTask(2)?.phase).toBe('completed'))
  expect(repository.commands).toHaveLength(2)
})

it('reports oversized serialized examples during preview before confirmation', () => {
  const repository = memoryRepository()
  const service = new VocabularyTransferService(repository, () => ({ analyze: vi.fn() }))
  const rows = excel(['apple'])
  rows[1].cells.splice(4, 3, ...Array<string>(3).fill('"'.repeat(500)))
  const preview = service.preview(1, rows)
  expect(preview.valid).toBe(0)
  expect(preview.issues).toContainEqual({
    row: 2,
    field: 'example_sentence_1',
    code: 'INVALID_VALUE'
  })
  expect(() => service.confirm(1, preview.importId)).toThrow('INVALID_INPUT')
  expect(repository.commands).toHaveLength(0)
})

it('reports the storage failure cause through the log sink instead of dropping it', () => {
  const repository = memoryRepository()
  const failure = new VocabularyError('STORAGE_FAILED', { cause: new Error('disk full') })
  repository.saveBatch = vi.fn(() => {
    throw failure
  })
  const logged: unknown[] = []
  const service = new VocabularyTransferService(
    repository,
    () => ({ analyze: vi.fn() }),
    () => 0,
    (error) => logged.push(error)
  )
  const preview = service.preview(1, excel(['apple']))
  const task = service.confirm(1, preview.importId)
  expect(task).toMatchObject({ phase: 'failed', counts: { saved: 0, failed: 1 } })
  expect(logged).toEqual([failure])
})
