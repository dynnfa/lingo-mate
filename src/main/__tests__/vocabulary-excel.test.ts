import { describe, expect, it } from 'vitest'
import ExcelJS from 'exceljs'
import { decodeVocabularyExcel, encodeVocabularyExcel } from '../vocabulary-excel'
import { content } from '../../core/learning/vocabulary/__tests__/fixtures'

describe('vocabulary Excel', () => {
  it('round trips complete content as strings and leaves legacy NULL fields blank', async () => {
    const data = content('apple', { meaning: '=1+1' })
    const bytes = await encodeVocabularyExcel(
      [data, { term: 'old', phonetic: null, meaning: null, concept: null, exampleSentences: null }],
      'en'
    )
    const rows = await decodeVocabularyExcel(bytes)
    expect(rows[0].cells).toEqual([
      'term',
      'phonetic',
      'meaning',
      'concept',
      'example_sentence_1',
      'example_sentence_2',
      'example_sentence_3'
    ])
    expect(rows[1].cells).toEqual([
      'apple',
      data.phonetic,
      '=1+1',
      data.concept,
      data.exampleSentences[0],
      '',
      ''
    ])
    expect(rows[2].cells).toEqual(['old', '', '', '', '', '', ''])
    const book = new ExcelJS.Workbook()
    await book.xlsx.load(Uint8Array.from(bytes).buffer)
    expect(book.getWorksheet('vocabulary')!.getCell('C2').type).toBe(ExcelJS.ValueType.String)
    expect(book.getWorksheet('instructions')).toBeDefined()
  })
})

it('rejects oversized input before parsing', async () => {
  await expect(decodeVocabularyExcel(Buffer.alloc(5 * 1024 * 1024 + 1))).rejects.toMatchObject({
    code: 'LIMIT_EXCEEDED'
  })
})
it('rejects decompression bombs and excessive cells before workbook parsing', async () => {
  const { zipSync, strToU8 } = await import('fflate')
  const bomb = zipSync({ 'xl/worksheets/sheet1.xml': strToU8(' '.repeat(25 * 1024 * 1024)) })
  await expect(decodeVocabularyExcel(Buffer.from(bomb))).rejects.toMatchObject({
    code: 'LIMIT_EXCEEDED'
  })
  const cells = zipSync({
    'xl/worksheets/sheet1.xml': strToU8(
      '<worksheet>' + '<c r="A1"/>'.repeat(20001) + '</worksheet>'
    )
  })
  await expect(decodeVocabularyExcel(Buffer.from(cells))).rejects.toMatchObject({
    code: 'LIMIT_EXCEEDED'
  })
})
it('keeps formula and error cells non-text so validation can reject them', async () => {
  const book = new ExcelJS.Workbook()
  const sheet = book.addWorksheet('vocabulary')
  sheet.addRow([
    'term',
    'phonetic',
    'meaning',
    'concept',
    'example_sentence_1',
    'example_sentence_2',
    'example_sentence_3'
  ])
  sheet.addRow([
    'apple',
    '/æpəl/',
    { formula: '1+1', result: 'cached' },
    { error: '#N/A' },
    'An apple.'
  ])
  const rows = await decodeVocabularyExcel(Buffer.from(await book.xlsx.writeBuffer()))
  expect(typeof rows[1].cells[2]).toBe('object')
  expect(typeof rows[1].cells[3]).toBe('object')
})

it('rejects merged ranges before they can expand the decoded cell count', async () => {
  const book = new ExcelJS.Workbook()
  const sheet = book.addWorksheet('vocabulary')
  sheet.getCell('A1').value = 'term'
  sheet.mergeCells('A1:B2')
  await expect(
    decodeVocabularyExcel(Buffer.from(await book.xlsx.writeBuffer()))
  ).rejects.toMatchObject({ code: 'INVALID_FILE' })
})

it('bounds XML coordinates even with single quotes and escaped attribute values', async () => {
  const { zipSync, strToU8 } = await import('fflate')
  const workbook = zipSync({
    'xl/worksheets/sheet1.xml': strToU8(
      "<worksheet><row r='20001'><c r='A&#x32;0001'/></row></worksheet>"
    )
  })
  await expect(decodeVocabularyExcel(Buffer.from(workbook))).rejects.toMatchObject({
    code: 'LIMIT_EXCEEDED'
  })
})
