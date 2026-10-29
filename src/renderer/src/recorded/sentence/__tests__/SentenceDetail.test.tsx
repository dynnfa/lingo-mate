// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { I18nextProvider } from 'react-i18next'
import { createI18n } from '../../../i18n'
import { SentenceDetail } from '../SentenceDetail'
const entry = {
  id: '11111111-1111-4111-8111-111111111111',
  sourceText: '今天先这样吧。',
  translation: "Let's call it a day.",
  targetLanguage: 'en' as const,
  createdAt: '2026-10-29T00:00:00.000Z'
}
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})
it('shows original and translation, confirms deletion, and returns focus to the heading', async () => {
  const remove = vi.fn().mockResolvedValue({ status: 'ok', id: entry.id, deleted: true })
  vi.stubGlobal('api', {
    sentence: {
      list: vi.fn().mockResolvedValue({ status: 'ok', entries: [entry] }),
      delete: remove
    }
  })
  render(
    <I18nextProvider i18n={createI18n('zh-CN')}>
      <SentenceDetail />
    </I18nextProvider>
  )
  expect(await screen.findByText(entry.sourceText)).toBeInTheDocument()
  expect(screen.getByText(entry.translation)).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: `删除 ${entry.sourceText}` }))
  expect(remove).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: '删除' }))
  await waitFor(() => expect(remove).toHaveBeenCalledWith({ id: entry.id }))
  await waitFor(() => expect(screen.getByRole('heading', { name: '句子' })).toHaveFocus())
  expect(screen.queryByText(entry.translation)).not.toBeInTheDocument()
})

it('retries initial and subsequent page failures using the same cursor', async () => {
  const cursor = { createdAt: entry.createdAt, id: entry.id }
  const second = {
    ...entry,
    id: '22222222-2222-4222-8222-222222222222',
    sourceText: '明天继续。',
    translation: 'We can pick this up tomorrow.'
  }
  const list = vi
    .fn()
    .mockResolvedValueOnce({ status: 'error', error: { code: 'STORAGE_FAILED' } })
    .mockResolvedValueOnce({ status: 'ok', entries: [entry], nextCursor: cursor })
    .mockResolvedValueOnce({ status: 'error', error: { code: 'STORAGE_FAILED' } })
    .mockResolvedValueOnce({ status: 'ok', entries: [second] })
  vi.stubGlobal('api', { sentence: { list, delete: vi.fn() } })
  render(
    <I18nextProvider i18n={createI18n('zh-CN')}>
      <SentenceDetail />
    </I18nextProvider>
  )
  fireEvent.click(await screen.findByRole('button', { name: '重试' }))
  expect(await screen.findByText(entry.translation)).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: '加载更多' }))
  fireEvent.click(await screen.findByRole('button', { name: '重试' }))
  expect(await screen.findByText(second.translation)).toBeInTheDocument()
  expect(list.mock.calls.map(([input]) => input)).toEqual([{}, {}, { cursor }, { cursor }])
  expect(screen.queryByRole('button', { name: '加载更多' })).not.toBeInTheDocument()
})

it('renders translated headers and retains the record when deletion fails', async () => {
  vi.stubGlobal('api', {
    sentence: {
      list: vi.fn().mockResolvedValue({ status: 'ok', entries: [entry] }),
      delete: vi.fn().mockResolvedValue({ status: 'error', error: { code: 'STORAGE_FAILED' } })
    }
  })
  render(
    <I18nextProvider i18n={createI18n('en')}>
      <SentenceDetail />
    </I18nextProvider>
  )
  await screen.findByText(entry.translation)
  expect(screen.getAllByRole('columnheader').map((element) => element.textContent)).toEqual([
    'Original',
    'Translation',
    'Created',
    'Actions'
  ])
  fireEvent.click(screen.getByRole('button', { name: `Delete ${entry.sourceText}` }))
  fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
  await waitFor(() => expect(screen.getByRole('dialog')).toBeInTheDocument())
  expect(screen.getByText(entry.translation)).toBeInTheDocument()
})
