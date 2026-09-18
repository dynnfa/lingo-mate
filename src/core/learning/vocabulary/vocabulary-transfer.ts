import { randomUUID } from 'node:crypto'
import {
  VOCABULARY_COLUMNS,
  VOCABULARY_TRANSFER_LIMITS as LIMITS,
  type ImportIssue,
  type ImportPreview,
  type ImportRow,
  type ImportTask,
  type TransferErrorCode
} from '../../../shared/vocabulary-transfer'
import type { VocabularyRepository } from './vocabulary-repository'
import type { VocabularyAnalyzer } from './vocabulary-analyzer'
import {
  buildVocabularyInsertCommand,
  insertToolArgumentsSchema,
  type VocabularyInsertCommand,
  type VocabularyInsertContent
} from './vocabulary-insert'
import { abortableOperation } from './abortable-operation'
import type { SupportedLocale } from '../../../shared/preferences'
import { startImportSchema } from '../../../shared/vocabulary-transfer'
import { normalizeLookupKey, VocabularyError } from './parse-vocabulary-input'

export class TransferError extends Error {
  constructor(
    readonly code: TransferErrorCode,
    options?: ErrorOptions
  ) {
    super(code, options)
  }
}
export interface ImportDataRow {
  row: number
  cells: unknown[]
}
interface PreviewRecord {
  owner: number
  expires: number
  preview: ImportPreview
  rows: ImportRow[]
  contents: Map<number, VocabularyInsertContent>
  result?: ImportTask
}
export class VocabularyTransferService {
  private tasks = new Map<number, { task: ImportTask; controller: AbortController }>()
  private issued = new Map<number, Set<string>>()
  private previews = new Map<string, PreviewRecord>()
  constructor(
    private readonly repository: Pick<VocabularyRepository, 'findExisting' | 'saveBatch'>,
    private readonly createAnalyzer: () => VocabularyAnalyzer,
    private readonly now = Date.now
  ) {}

  getTask(owner: number, requestId?: string): ImportTask | null {
    const record = this.tasks.get(owner)
    if (requestId && record?.task.requestId !== requestId)
      throw new TransferError('REQUEST_NOT_FOUND')
    return record ? structuredClone(record.task) : null
  }
  assertIdle(owner: number): void {
    const phase = this.tasks.get(owner)?.task.phase
    if (phase === 'analyzing' || phase === 'committing') throw new TransferError('BUSY')
  }
  start(
    owner: number,
    raw: { requestId: string; text: string; retryRequestId?: string },
    locale: SupportedLocale,
    notify: (task: ImportTask) => void = () => {}
  ): ImportTask {
    const parsed = startImportSchema.safeParse(raw)
    if (!parsed.success) throw new TransferError('INVALID_INPUT')
    const input = parsed.data
    const previous = this.tasks.get(owner)
    if (previous?.task.requestId === input.requestId) return structuredClone(previous.task)
    this.assertIdle(owner)
    const issued = this.issued.get(owner) ?? new Set<string>()
    if (issued.has(input.requestId) || issued.size >= 1000) throw new TransferError('INVALID_INPUT')
    let terms: { row: number; term: string }[]
    if (input.retryRequestId) {
      if (
        previous?.task.requestId !== input.retryRequestId ||
        previous.task.phase === 'cancelled' ||
        previous.task.kind !== 'ai'
      )
        throw new TransferError('REQUEST_NOT_FOUND')
      terms = previous.task.rows
        .filter((row) => row.status === 'failed')
        .map(({ row, term }) => ({ row, term }))
    } else
      terms = input.text
        .split(/\r?\n/)
        .map((term, i) => ({ row: i + 1, term: term.trim() }))
        .filter((row) => row.term)
    if (
      !terms.length ||
      terms.length > LIMITS.aiRows ||
      terms.some((row) => row.term.length > 4000)
    )
      throw new TransferError('LIMIT_EXCEEDED')
    // Resolve configuration before creating a task, even when every term already exists.
    const analyzer = this.createAnalyzer()
    const task = newTask(input.requestId, this.classify(terms))
    const controller = new AbortController()
    this.tasks.set(owner, { task, controller })
    issued.add(input.requestId)
    this.issued.set(owner, issued)
    const publish = (): void => {
      updateCounts(task)
      task.revision++
      if (this.tasks.get(owner)?.task === task) {
        try {
          notify(structuredClone(task))
        } catch {
          /* The query API remains authoritative if delivery fails. */
        }
      }
    }
    publish()
    void this.analyze(task, analyzer, controller.signal, locale, publish)
    return structuredClone(task)
  }
  cancel(owner: number, requestId: string): ImportTask {
    const record = this.tasks.get(owner)
    if (!record || record.task.requestId !== requestId) throw new TransferError('REQUEST_NOT_FOUND')
    if (record.task.phase === 'analyzing') record.controller.abort()
    return structuredClone(record.task)
  }
  private async analyze(
    task: ImportTask,
    analyzer: VocabularyAnalyzer,
    signal: AbortSignal,
    locale: SupportedLocale,
    publish: () => void
  ): Promise<void> {
    const commands: VocabularyInsertCommand[] = []
    const analyzed: ImportRow[] = []
    try {
      for (const row of task.rows) {
        if (signal.aborted) break
        if (row.status !== 'pending') continue
        try {
          const result = await abortableOperation(signal, 30_000, (childSignal) =>
            analyzer.analyze({
              term: row.term,
              wordLanguage: 'en',
              explanationLanguage: locale,
              signal: childSignal
            })
          )
          if (result.status === 'unrecognized') throw new VocabularyError('UNRECOGNIZED')
          const content = result.content
          const valid = insertToolArgumentsSchema.safeParse({
            term: content.term,
            phonetic: content.phonetic,
            meaning: content.meaning,
            concept: content.concept,
            example_sentences: content.exampleSentences
          })
          if (!valid.success || content.term !== row.term)
            throw new VocabularyError('INVALID_ANALYSIS')
          commands.push(
            buildVocabularyInsertCommand(content, {
              id: randomUUID(),
              createdAt: new Date().toISOString(),
              modelId: result.modelId,
              promptVersion: result.promptVersion
            })
          )
          analyzed.push(row)
          row.status = 'analyzed'
        } catch (error) {
          row.status = 'failed'
          row.code = error instanceof VocabularyError ? error.code : 'MODEL_ERROR'
        }
        publish()
      }
      if (signal.aborted) {
        for (const row of task.rows)
          if (row.status === 'pending' || row.status === 'analyzed') {
            row.status = 'failed'
            row.code = 'CANCELLED'
          }
        finish(task)
        task.phase = 'cancelled'
      } else {
        task.phase = 'committing'
        publish()
        this.commit(task, analyzed, commands)
      }
    } finally {
      publish()
    }
  }

  preview(owner: number, data: ImportDataRow[]): ImportPreview {
    this.assertIdle(owner)
    this.expire()
    for (const [id, record] of this.previews) if (record.owner === owner) this.previews.delete(id)
    const issues: ImportIssue[] = []
    const header = data.find((row) => row.row === 1)?.cells ?? []
    if (
      header.length !== VOCABULARY_COLUMNS.length ||
      VOCABULARY_COLUMNS.some((column) => header.filter((cell) => cell === column).length !== 1)
    ) {
      issues.push({ row: 1, field: 'header', code: 'INVALID_HEADER' })
    }
    const nonempty = data.filter(
      (row) =>
        row.row !== 1 &&
        row.cells.some((cell) => cell !== '' && cell !== null && cell !== undefined)
    )
    if (nonempty.length > LIMITS.excelRows) throw new TransferError('LIMIT_EXCEEDED')
    const contents = new Map<number, VocabularyInsertContent>()
    if (!issues.length)
      for (const line of nonempty) {
        const values = Object.fromEntries(
          VOCABULARY_COLUMNS.map((column) => [column, line.cells[header.indexOf(column)] ?? ''])
        )
        const before = issues.length
        for (const column of VOCABULARY_COLUMNS) {
          if (typeof values[column] !== 'string')
            issues.push({ row: line.row, field: column, code: 'INVALID_CELL' })
          else values[column] = (values[column] as string).trim()
        }
        if (line.cells.slice(header.length).some((cell) => cell !== '' && cell != null))
          issues.push({ row: line.row, field: 'header', code: 'INVALID_HEADER' })
        if (issues.length !== before) continue
        for (const column of VOCABULARY_COLUMNS.slice(0, 5))
          if (!values[column]) issues.push({ row: line.row, field: column, code: 'REQUIRED' })
        const examples = VOCABULARY_COLUMNS.slice(4)
          .map((column) => values[column] as string)
          .filter(Boolean)
        const parsed = insertToolArgumentsSchema.safeParse({
          term: values.term,
          phonetic: values.phonetic,
          meaning: values.meaning,
          concept: values.concept,
          example_sentences: examples
        })
        if (!/^\p{Script=Latin}[\p{Script=Latin}\p{M}\s'’.-]*$/u.test(values.term as string))
          issues.push({ row: line.row, field: 'term', code: 'INVALID_VALUE' })
        if (!parsed.success)
          for (const issue of parsed.error.issues) {
            const field =
              issue.path[0] === 'example_sentences'
                ? (VOCABULARY_COLUMNS.slice(4).filter((column) => values[column])[
                    Number(issue.path[1] ?? 0)
                  ] ?? 'example_sentence_1')
                : (issue.path[0] as (typeof VOCABULARY_COLUMNS)[number])
            if (!issues.some((item) => item.row === line.row && item.field === field))
              issues.push({ row: line.row, field, code: 'INVALID_VALUE' })
          }
        if (parsed.success && issues.length === before)
          contents.set(line.row, {
            term: parsed.data.term,
            phonetic: parsed.data.phonetic,
            meaning: parsed.data.meaning,
            concept: parsed.data.concept,
            exampleSentences: parsed.data.example_sentences
          })
      }
    const rows = this.classify([...contents].map(([row, content]) => ({ row, term: content.term })))
    const preview: ImportPreview = {
      importId: randomUUID(),
      total: nonempty.length,
      valid: contents.size,
      existing: rows.filter((row) => row.status === 'existing').length,
      duplicate: rows.filter((row) => row.status === 'duplicate').length,
      issues
    }
    this.previews.set(preview.importId, {
      owner,
      expires: this.now() + LIMITS.previewMs,
      preview,
      rows,
      contents
    })
    return preview
  }

  confirm(owner: number, id: string): ImportTask {
    this.expire()
    const record = this.previews.get(id)
    if (!record || record.owner !== owner) throw new TransferError('PREVIEW_EXPIRED')
    if (record.result) return structuredClone(record.result)
    this.assertIdle(owner)
    if (record.preview.issues.length) throw new TransferError('INVALID_INPUT')
    const task = newTask(id, structuredClone(record.rows))
    const pending = task.rows.filter((row) => row.status === 'pending')
    this.commit(
      task,
      pending,
      pending.map((row) =>
        buildVocabularyInsertCommand(record.contents.get(row.row)!, {
          id: randomUUID(),
          createdAt: new Date().toISOString(),
          modelId: 'manual-import',
          promptVersion: 'vocabulary-excel-v1'
        })
      )
    )
    task.kind = 'excel'
    this.tasks.set(owner, { task, controller: new AbortController() })
    record.result = task
    record.contents.clear()
    return structuredClone(task)
  }

  release(owner: number): void {
    this.tasks.get(owner)?.controller.abort()
    this.tasks.delete(owner)
    this.issued.delete(owner)
    for (const [id, record] of this.previews) if (record.owner === owner) this.previews.delete(id)
  }
  expire(): void {
    for (const [id, record] of this.previews)
      if (record.expires <= this.now()) this.previews.delete(id)
  }
  private classify(input: { row: number; term: string }[]): ImportRow[] {
    const found = this.repository.findExisting(input.map((row) => normalizeLookupKey(row.term)))
    const seen = new Map<string, number>()
    return input.map(({ row, term }) => {
      const key = normalizeLookupKey(term)
      const sourceRow = seen.get(key)
      if (sourceRow !== undefined) return { row, term, status: 'duplicate', sourceRow }
      seen.set(key, row)
      return { row, term, status: found.has(key) ? 'existing' : 'pending' }
    })
  }
  private commit(task: ImportTask, rows: ImportRow[], commands: VocabularyInsertCommand[]): void {
    task.phase = 'committing'
    try {
      const results = this.repository.saveBatch(commands)
      rows.forEach((row, i) => {
        row.status = results[i].status
      })
    } catch {
      rows.forEach((row) => {
        row.status = 'failed'
        row.code = 'STORAGE_FAILED'
      })
    }
    finish(task)
  }
}
function newTask(requestId: string, rows: ImportRow[]): ImportTask {
  return {
    kind: 'ai',
    requestId,
    revision: 0,
    phase: 'analyzing',
    processed: 0,
    total: rows.length,
    rows,
    counts: { saved: 0, existing: 0, duplicate: 0, failed: 0 }
  }
}
function updateCounts(task: ImportTask): void {
  task.processed = task.rows.filter((row) => row.status !== 'pending').length
  task.counts = { saved: 0, existing: 0, duplicate: 0, failed: 0 }
  for (const row of task.rows)
    if (row.status in task.counts) task.counts[row.status as keyof ImportTask['counts']]++
}
function finish(task: ImportTask): void {
  updateCounts(task)
  const resolved = task.rows.filter(
    (row) =>
      row.status === 'saved' ||
      row.status === 'existing' ||
      (row.status === 'duplicate' &&
        task.rows.some(
          (source) =>
            source.row === row.sourceRow &&
            (source.status === 'saved' || source.status === 'existing')
        ))
  ).length
  task.phase = resolved === task.total ? 'completed' : resolved ? 'partial' : 'failed'
  task.revision++
}
