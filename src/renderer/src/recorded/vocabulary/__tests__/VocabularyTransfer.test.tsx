// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { I18nextProvider } from 'react-i18next'
import { createI18n } from '../../../i18n'
import { VocabularyTransfer } from '../VocabularyTransfer'
import { transferApiStub } from './helpers/transfer-api'
import { importTaskSchema, type ImportTask } from '../../../../../shared/vocabulary-transfer'
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})
it('offers both modes, downloads a template, and blocks confirmation of invalid rows', async () => {
  const api = {
    ...transferApiStub(),
    downloadTemplate: vi.fn(async () => ({ status: 'ok' as const })),
    previewExcel: vi.fn(async () => ({
      status: 'ok' as const,
      preview: {
        importId: '11111111-1111-4111-8111-111111111111',
        total: 1,
        valid: 0,
        existing: 0,
        duplicate: 0,
        issues: [{ row: 2, field: 'phonetic' as const, code: 'REQUIRED' as const }]
      }
    }))
  }
  vi.stubGlobal('api', { vocabulary: api })
  render(
    <I18nextProvider i18n={createI18n('en')}>
      <VocabularyTransfer onSaved={() => {}} />
    </I18nextProvider>
  )
  fireEvent.click(screen.getByRole('button', { name: 'Import' }))
  fireEvent.click(screen.getByRole('button', { name: 'Download Excel template' }))
  await screen.findByText('File saved.')
  expect(api.downloadTemplate).toHaveBeenCalledOnce()
  fireEvent.click(screen.getByRole('button', { name: 'Select Excel file' }))
  await screen.findByText(/Row 2 · phonetic/)
  expect(screen.getByRole('button', { name: 'Confirm import' })).toBeDisabled()
  fireEvent.click(screen.getByRole('button', { name: 'AI assisted import' }))
  expect(screen.getByRole('textbox', { name: 'One English word per line' })).toBeVisible()
})

it('restores progress, prevents duplicate starts, cancels and refreshes the list only after a saved result', async () => {
  const { importTaskSchema } = await import('../../../../../shared/vocabulary-transfer')
  const task = importTaskSchema.parse({
    kind: 'ai',
    requestId: '11111111-1111-4111-8111-111111111111',
    revision: 1,
    phase: 'analyzing',
    processed: 0,
    total: 1,
    rows: [{ row: 1, term: 'apple', status: 'pending' }],
    counts: { saved: 0, existing: 0, duplicate: 0, failed: 0 }
  })
  let listener: (value: typeof task) => void = () => {}
  const api = {
    ...transferApiStub(),
    getImportTask: vi.fn(async () => ({ status: 'ok' as const, task })),
    onImportProgress: vi.fn((callback) => {
      listener = callback
      return () => {}
    }),
    cancelImport: vi.fn(async () => ({
      status: 'ok' as const,
      task: { ...task, revision: 2, phase: 'cancelled' as const }
    }))
  }
  const saved = vi.fn()
  vi.stubGlobal('api', { vocabulary: api })
  render(
    <I18nextProvider i18n={createI18n('en')}>
      <VocabularyTransfer onSaved={saved} />
    </I18nextProvider>
  )
  await screen.findByText('0 / 1 processed')
  fireEvent.click(screen.getByRole('button', { name: 'Import' }))
  expect(screen.getByRole('button', { name: 'Select Excel file' })).toBeDisabled()
  fireEvent.click(screen.getByRole('button', { name: 'Cancel import' }))
  await screen.findByText(/Cancelled; uncommitted/)
  expect(saved).not.toHaveBeenCalled()
  const { act } = await import('@testing-library/react')
  act(() =>
    listener({
      ...task,
      phase: 'completed',
      revision: 3,
      processed: 1,
      rows: [{ row: 1, term: 'apple', status: 'saved' }],
      counts: { ...task.counts, saved: 1 }
    })
  )
  expect(saved).toHaveBeenCalledOnce()
})
it('normal file dialog cancellation does not display an error', async () => {
  vi.stubGlobal('api', { vocabulary: transferApiStub() })
  render(
    <I18nextProvider i18n={createI18n('en')}>
      <VocabularyTransfer onSaved={() => {}} />
    </I18nextProvider>
  )
  fireEvent.click(screen.getByRole('button', { name: 'Import' }))
  fireEvent.click(screen.getByRole('button', { name: 'Select Excel file' }))
  const { waitFor } = await import('@testing-library/react')
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Select Excel file' })).toBeEnabled()
  )
  expect(screen.queryByRole('alert')).not.toBeInTheDocument()
})

it('polls the task query only while an import task is active', async () => {
  vi.useFakeTimers()
  try {
    const base = {
      kind: 'ai',
      requestId: '11111111-1111-4111-8111-111111111111',
      revision: 1,
      phase: 'analyzing',
      processed: 0,
      total: 1,
      rows: [{ row: 1, term: 'apple', status: 'pending' }],
      counts: { saved: 0, existing: 0, duplicate: 0, failed: 0 }
    }
    const analyzing = importTaskSchema.parse(base)
    const terminal = importTaskSchema.parse({
      ...base,
      revision: 2,
      phase: 'completed',
      processed: 1,
      rows: [{ row: 1, term: 'apple', status: 'saved' }],
      counts: { saved: 1, existing: 0, duplicate: 0, failed: 0 }
    })
    let current: ImportTask | null = null
    let listener: (value: ImportTask) => void = () => {}
    const api = {
      ...transferApiStub(),
      getImportTask: vi.fn(async () => ({ status: 'ok' as const, task: current })),
      onImportProgress: vi.fn((callback: (value: ImportTask) => void) => {
        listener = callback
        return () => {}
      })
    }
    vi.stubGlobal('api', { vocabulary: api })
    render(
      <I18nextProvider i18n={createI18n('en')}>
        <VocabularyTransfer onSaved={() => {}} />
      </I18nextProvider>
    )
    await vi.advanceTimersByTimeAsync(0)
    expect(api.getImportTask).toHaveBeenCalledTimes(1)
    // Idle window: the mount recovery query is the only call.
    await vi.advanceTimersByTimeAsync(3000)
    expect(api.getImportTask).toHaveBeenCalledTimes(1)
    // While analyzing, the interval backs up the progress events.
    current = analyzing
    act(() => listener(analyzing))
    await vi.advanceTimersByTimeAsync(2500)
    expect(api.getImportTask).toHaveBeenCalledTimes(3)
    // After the terminal phase, polling stops again.
    const settled = api.getImportTask.mock.calls.length
    current = terminal
    act(() => listener(terminal))
    await vi.advanceTimersByTimeAsync(2500)
    expect(api.getImportTask).toHaveBeenCalledTimes(settled)
  } finally {
    vi.useRealTimers()
  }
})
