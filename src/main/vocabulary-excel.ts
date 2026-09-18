import ExcelJS from 'exceljs'
import { SaxesParser } from 'saxes'
import { Unzip, UnzipInflate, zipSync } from 'fflate'
import { TransferError } from '../core/learning/vocabulary/vocabulary-transfer'
import { VOCABULARY_TRANSFER_LIMITS as LIMITS } from '../shared/vocabulary-transfer'
import type { VocabularyEntry } from '../shared/vocabulary'
import { VOCABULARY_COLUMNS } from '../shared/vocabulary-transfer'
import type { SupportedLocale } from '../shared/preferences'
import en from '../shared/locales/en/vocabulary.json'
import zh from '../shared/locales/zh-CN/vocabulary.json'

export interface ExcelDataRow {
  row: number
  cells: unknown[]
}
export async function encodeVocabularyExcel(
  entries: Pick<
    VocabularyEntry,
    'term' | 'phonetic' | 'meaning' | 'concept' | 'exampleSentences'
  >[],
  locale: SupportedLocale
): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook()
  const sheet = workbook.addWorksheet('vocabulary')
  sheet.addRow([...VOCABULARY_COLUMNS])
  sheet.columns.forEach((column, index) => {
    column.width = index < 2 ? 24 : 50
  })
  sheet.views = [{ state: 'frozen', ySplit: 1 }]
  for (const entry of entries)
    sheet.addRow([
      entry.term,
      entry.phonetic?.join('\n') ?? '',
      entry.meaning ?? '',
      entry.concept ?? '',
      ...[0, 1, 2].map((i) => entry.exampleSentences?.[i] ?? '')
    ])
  sheet.eachRow((row) => {
    row.alignment = { vertical: 'top', wrapText: true }
  })
  sheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } }
  sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF245B78' } }
  const instructions = workbook.addWorksheet('instructions')
  instructions.getColumn(1).width = 110
  const messages = (locale === 'en' ? en : zh).transfer
  for (const line of messages.instructions) {
    const row = instructions.addRow([line])
    row.alignment = { wrapText: true, vertical: 'top' }
    row.height = 48
  }
  return Buffer.from(await workbook.xlsx.writeBuffer())
}
export async function decodeVocabularyExcel(bytes: Buffer): Promise<ExcelDataRow[]> {
  const workbook = new ExcelJS.Workbook()
  try {
    await workbook.xlsx.load(Uint8Array.from(boundedArchive(bytes)).buffer)
  } catch (error) {
    if (error instanceof TransferError) throw error
    throw new TransferError('INVALID_FILE', { cause: error })
  }
  const sheet = workbook.getWorksheet('vocabulary')
  if (!sheet) throw new TransferError('INVALID_FILE')
  const rows: ExcelDataRow[] = []
  sheet.eachRow({ includeEmpty: false }, (row) => {
    rows.push({
      row: row.number,
      cells: Array.from(
        { length: Math.max(7, row.cellCount) },
        (_, i) => row.getCell(i + 1).value ?? ''
      )
    })
  })
  return rows
}

// Stream in small compressed chunks, bound actual output (not ZIP metadata), then
// rebuild a canonical archive. ExcelJS never sees the untrusted ZIP directory.
function boundedArchive(bytes: Buffer): Buffer {
  if (bytes.length > LIMITS.fileBytes) throw new TransferError('LIMIT_EXCEEDED')
  let expanded = 0
  let cellCount = 0
  let elementCount = 0
  let fileCount = 0
  let completed = 0
  const files: Record<string, Uint8Array> = Object.create(null)
  const names = new Set<string>()
  const unzip = new Unzip((file) => {
    if (
      ++fileCount > LIMITS.archiveEntries ||
      names.has(file.name) ||
      file.name.includes('..') ||
      file.name.startsWith('/')
    )
      throw new TransferError('INVALID_FILE')
    names.add(file.name)
    const chunks: Uint8Array[] = []
    file.ondata = (error, chunk, final) => {
      if (error) throw error
      expanded += chunk.length
      if (expanded > LIMITS.expandedBytes) throw new TransferError('LIMIT_EXCEEDED')
      chunks.push(chunk)
      if (final) {
        const data = Buffer.concat(chunks)
        if (file.name.endsWith('.xml') || file.name.endsWith('.rels')) {
          // SAX decodes attributes before checking limits: quoting, whitespace and
          // numeric character references cannot bypass coordinate checks.
          const parser = new SaxesParser({ xmlns: false })
          parser.on('doctype', () => {
            throw new TransferError('INVALID_FILE')
          })
          parser.on('opentag', (tag) => {
            if (++elementCount > LIMITS.xmlElements) throw new TransferError('LIMIT_EXCEEDED')
            const name = tag.name.split(':').at(-1)
            if (name === 'mergeCell') throw new TransferError('INVALID_FILE')
            if (name === 'c') {
              if (++cellCount > LIMITS.cells) throw new TransferError('LIMIT_EXCEEDED')
              const reference = /^([A-Z]+)([1-9]\d*)$/.exec(tag.attributes.r ?? '')
              if (!reference) throw new TransferError('INVALID_FILE')
              const column = [...reference[1]].reduce(
                (value, letter) => value * 26 + letter.charCodeAt(0) - 64,
                0
              )
              if (column > LIMITS.columns || Number(reference[2]) > LIMITS.cells)
                throw new TransferError('LIMIT_EXCEEDED')
            }
            const bound =
              name === 'row'
                ? (['r', LIMITS.cells] as const)
                : name === 'col'
                  ? (['max', LIMITS.columns] as const)
                  : name === 'sheet'
                    ? (['sheetId', LIMITS.archiveEntries] as const)
                    : undefined
            if (
              bound &&
              (!/^[1-9]\d*$/.test(tag.attributes[bound[0]] ?? '') ||
                Number(tag.attributes[bound[0]]) > bound[1])
            )
              throw new TransferError('LIMIT_EXCEEDED')
          })
          parser.write(data.toString('utf8')).close()
        }
        files[file.name] = data
        completed++
      }
    }
    file.start()
  })
  unzip.register(UnzipInflate)
  try {
    for (let offset = 0; offset < bytes.length; offset += 1024)
      unzip.push(bytes.subarray(offset, offset + 1024), offset + 1024 >= bytes.length)
    if (!fileCount || completed !== fileCount) throw new TransferError('INVALID_FILE')
    return Buffer.from(zipSync(files, { level: 0 }))
  } catch (error) {
    if (error instanceof TransferError) throw error
    throw new TransferError('INVALID_FILE', { cause: error })
  }
}
