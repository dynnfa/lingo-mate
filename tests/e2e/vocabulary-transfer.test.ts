import { join } from 'node:path'
import { readFile, writeFile } from 'node:fs/promises'
import ExcelJS from 'exceljs'
import {
  expect,
  launchApp,
  test,
  waitForReady,
  withTempUserData,
  writeLocalePreference,
  writeModelsConfig
} from './helpers'
import { startVocabularyServer } from '../integration/fixtures/vocabulary-server'
import { encodeVocabularyExcel } from '../../src/main/vocabulary-excel'
import { content } from '../../src/core/learning/vocabulary/__tests__/fixtures'

test('imports Excel and AI content from the recorded menu, downloads a template and exports the full vocabulary', async () => {
  const server = await startVocabularyServer()
  try {
    await withTempUserData(async (directory) => {
      await writeLocalePreference(directory, 'en')
      await writeModelsConfig(directory, server.baseUrl, 'test-model')
      const input = join(directory, 'input.xlsx')
      const output = join(directory, 'export.xlsx')
      const template = join(directory, 'template.xlsx')
      await writeFile(input, await encodeVocabularyExcel([content('apple')], 'en'))
      const app = await launchApp(directory)
      try {
        await app.evaluate(
          ({ dialog }, paths) => {
            dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [paths.input] })
            let count = 0
            dialog.showSaveDialog = async () => ({
              canceled: false,
              filePath: ++count === 1 ? paths.template : paths.output
            })
          },
          { input, output, template }
        )
        const window = await app.firstWindow()
        await waitForReady(window)
        await window.getByRole('button', { name: 'Recorded vocabulary', exact: true }).click()
        await window.getByRole('button', { name: 'Import', exact: true }).click()
        const modal = window.getByRole('dialog', { name: 'Import vocabulary' })
        await modal.getByRole('button', { name: 'Download Excel template' }).click()
        await expect(modal.getByText('File saved.')).toBeVisible()
        const templateBook = new ExcelJS.Workbook()
        await templateBook.xlsx.load(Uint8Array.from(await readFile(template)).buffer)
        expect(templateBook.getWorksheet('vocabulary')!.rowCount).toBe(1)
        await modal.getByRole('button', { name: 'Select Excel file' }).click()
        await expect(modal.getByText('1 rows · 1 valid · 0 existing · 0 duplicates')).toBeVisible()
        await modal.getByRole('button', { name: 'Confirm import' }).click()
        await expect(
          modal.getByText('1 added · 0 existing · 0 duplicates · 0 failed')
        ).toBeVisible()
        expect(server.terms).toEqual([])
        await modal.getByRole('button', { name: 'AI assisted import' }).click()
        await modal.getByRole('textbox').fill('apple\nbanana\nbanana\nbad')
        await modal.getByRole('button', { name: 'Start import' }).click()
        await expect(
          modal.getByText('1 added · 1 existing · 1 duplicates · 1 failed')
        ).toBeVisible()
        expect(server.terms).toEqual(['banana', 'bad'])
        await modal.getByRole('button', { name: 'Retry failed rows' }).click()
        await expect.poll(() => server.terms.length).toBe(3)
        await expect(
          modal.getByText('0 added · 0 existing · 0 duplicates · 1 failed')
        ).toBeVisible()
        expect(server.terms.at(-1)).toBe('bad')
        await modal.getByRole('button', { name: 'Close', exact: true }).click()
        await expect(window.locator('.vocabulary-table tbody tr')).toHaveCount(2)
        await window.getByRole('button', { name: 'Export Excel', exact: true }).click()
        await expect(window.getByText('File saved.')).toBeVisible()
        const exported = new ExcelJS.Workbook()
        await exported.xlsx.load(Uint8Array.from(await readFile(output)).buffer)
        const sheet = exported.getWorksheet('vocabulary')!
        expect(sheet.rowCount).toBe(3)
        expect([sheet.getCell('A2').value, sheet.getCell('A3').value]).toEqual(['banana', 'apple'])
        // Capture the implemented UI for visual acceptance, inside the isolated test output.
        await window.getByRole('button', { name: 'Import', exact: true }).click()
        await expect(modal.getByRole('heading', { name: 'Import vocabulary' })).toBeInViewport()
        await window.screenshot({ path: test.info().outputPath('vocabulary-import.png') })
      } finally {
        await app.close()
      }
    })
  } finally {
    await server.close()
  }
})
