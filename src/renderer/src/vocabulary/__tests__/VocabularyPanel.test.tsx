// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { I18nextProvider } from 'react-i18next'
import { createI18n } from '../../i18n'
import { VocabularyPanel } from '../VocabularyPanel'
import { ConversationPanel } from '../../conversation/ConversationPanel'
import type {
  AddVocabularyBatchInput,
  AddVocabularyBatchResult,
  VocabularyApi,
  VocabularyBatch,
  VocabularyEntry
} from '../../../../shared/vocabulary'

const entry: VocabularyEntry = {
  id: '11111111-1111-4111-8111-111111111111',
  term: 'apple',
  wordLanguage: 'en',
  explanationLanguage: 'zh-CN',
  analysisSource: 'llm',
  createdAt: '2026-09-07T00:00:00.000Z',
  analysis: {
    senses: [{ id: 's1', partOfSpeech: 'noun', definition: '苹果' }],
    pronunciations: [
      { accent: 'en-US', ipa: '/ˈæpəl/', guidance: '第一音节重读', senseIds: ['s1'] }
    ]
  }
}
function partial(requestId: string): VocabularyBatch {
  return {
    requestId,
    explanationLanguage: 'en',
    outcome: 'partial',
    counts: { total: 3, saved: 1, existing: 0, duplicate: 1, failed: 1 },
    items: [
      { inputIndex: 0, term: 'apple', status: 'saved', entryId: entry.id },
      { inputIndex: 1, term: 'bad', status: 'failed', code: 'UNRECOGNIZED' },
      { inputIndex: 2, term: 'bad', status: 'duplicate', sourceInputIndex: 1 }
    ]
  }
}
function apiStub(): VocabularyApi {
  return {
    list: vi.fn<VocabularyApi['list']>(async () => ({ status: 'ok', entries: [] })),
    cancelBatch: vi.fn<VocabularyApi['cancelBatch']>(async () => ({
      status: 'ok',
      outcome: 'cancelled'
    })),
    addBatch: vi.fn<VocabularyApi['addBatch']>(async () => ({
      status: 'error',
      error: { code: 'MODEL_NOT_CONFIGURED' }
    }))
  }
}
afterEach(cleanup)
describe('VocabularyPanel', () => {
  it('locks during a batch, preserves draft, renders per-item results and retries failures with a new ID', async () => {
    const api = apiStub()
    let finish!: (result: AddVocabularyBatchResult) => void
    const requests: AddVocabularyBatchInput[] = []
    api.addBatch = vi.fn<VocabularyApi['addBatch']>((input) => {
      requests.push(input)
      return new Promise((resolve) => {
        finish = resolve
      })
    })
    const i18n = createI18n('en')
    render(
      <I18nextProvider i18n={i18n}>
        <VocabularyPanel api={api} onExit={() => {}} />
      </I18nextProvider>
    )
    const input = screen.getByRole('textbox', { name: 'Words or phrases' })
    expect(input).toHaveFocus()
    fireEvent.change(input, { target: { value: 'apple,bad,bad' } })
    fireEvent.click(screen.getByRole('button', { name: 'Analyze and save' }))
    fireEvent.submit(input.closest('form')!)
    expect(api.addBatch).toHaveBeenCalledTimes(1)
    expect(input).toBeDisabled()
    api.list = vi.fn<VocabularyApi['list']>(async () => ({ status: 'ok', entries: [entry] }))
    await act(async () => finish({ status: 'ok', batch: partial(requests[0].requestId) }))
    expect(input).toHaveValue('apple,bad,bad')
    expect(input).toBeEnabled()
    expect(screen.getByText('Some entries need attention')).toBeInTheDocument()
    expect(screen.getByRole('region', { name: 'Batch results' })).toHaveTextContent(
      'Same as entry 2'
    )
    await waitFor(() => expect(screen.getByText('/ˈæpəl/')).toBeInTheDocument())
    await act(async () => {
      await i18n.changeLanguage('zh-CN')
    })
    expect(screen.getByText('部分词条需要重试')).toBeInTheDocument()
    expect(screen.getByText(/第一音节重读/)).toBeInTheDocument()
    expect(api.addBatch).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: '重试失败词条' }))
    expect(requests[1].text).toBe('bad')
    expect(requests[1].requestId).not.toBe(requests[0].requestId)
    await act(async () => finish({ status: 'error', error: { code: 'MODEL_ERROR' } }))
    expect(input).toHaveValue('bad')
  })
  it('waits for authoritative saved result after a too-late cancel', async () => {
    const api = apiStub()
    api.cancelBatch = vi.fn<VocabularyApi['cancelBatch']>(async () => ({
      status: 'ok',
      outcome: 'too_late'
    }))
    let finish!: (result: AddVocabularyBatchResult) => void
    let requestId = ''
    api.addBatch = vi.fn<VocabularyApi['addBatch']>((input) => {
      requestId = input.requestId
      return new Promise((resolve) => {
        finish = resolve
      })
    })
    render(
      <I18nextProvider i18n={createI18n('en')}>
        <VocabularyPanel api={api} onExit={() => {}} />
      </I18nextProvider>
    )
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'apple' } })
    fireEvent.click(screen.getByRole('button', { name: 'Analyze and save' }))
    fireEvent.click(screen.getByRole('button', { name: 'Cancel batch' }))
    await screen.findByText('The batch has reached storage. Waiting for its final result.')
    expect(screen.getByRole('textbox')).toBeDisabled()
    await act(async () =>
      finish({
        status: 'ok',
        batch: {
          ...partial(requestId),
          outcome: 'completed',
          counts: { total: 1, saved: 1, existing: 0, duplicate: 0, failed: 0 },
          items: [partial(requestId).items[0]]
        }
      })
    )
    expect(screen.getByRole('region', { name: 'Batch results' })).toHaveTextContent('Saved')
    expect(screen.queryByText('Batch cancelled; no new entries saved')).not.toBeInTheDocument()
  })
  it('does not submit during IME, cancels on unmount and ignores late responses', async () => {
    const api = apiStub()
    let finish!: (result: AddVocabularyBatchResult) => void
    api.addBatch = vi.fn<VocabularyApi['addBatch']>(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    const view = render(
      <I18nextProvider i18n={createI18n('en')}>
        <VocabularyPanel api={api} onExit={() => {}} />
      </I18nextProvider>
    )
    const input = screen.getByRole('textbox')
    fireEvent.change(input, { target: { value: 'apple' } })
    fireEvent.compositionStart(input)
    fireEvent.keyDown(input, { key: 'Enter', ctrlKey: true })
    fireEvent.submit(input.closest('form')!)
    expect(api.addBatch).not.toHaveBeenCalled()
    fireEvent.compositionEnd(input)
    fireEvent.keyDown(input, { key: 'Enter', ctrlKey: true })
    expect(api.addBatch).toHaveBeenCalledOnce()
    view.unmount()
    expect(api.cancelBatch).toHaveBeenCalledOnce()
    await act(async () => finish({ status: 'error', error: { code: 'UNKNOWN_ERROR' } }))
  })
  it('ignores mismatched request identities and keeps failed input editable', async () => {
    const api = apiStub()
    api.addBatch = vi.fn<VocabularyApi['addBatch']>(async () => ({
      status: 'ok',
      batch: partial('wrong-id')
    }))
    render(
      <I18nextProvider i18n={createI18n('en')}>
        <VocabularyPanel api={api} onExit={() => {}} />
      </I18nextProvider>
    )
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'apple' } })
    fireEvent.click(screen.getByRole('button', { name: 'Analyze and save' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('The vocabulary request failed')
    expect(screen.getByRole('textbox')).toHaveValue('apple')
    expect(screen.getByRole('textbox')).toBeEnabled()
    expect(screen.queryByRole('region', { name: 'Batch results' })).not.toBeInTheDocument()
  })
  it('paginates saved entries and can recover list errors', async () => {
    const api = apiStub()
    const list = vi
      .fn<VocabularyApi['list']>()
      .mockResolvedValueOnce({ status: 'error', error: { code: 'STORAGE_FAILED' } })
      .mockResolvedValueOnce({
        status: 'ok',
        entries: [entry],
        nextCursor: { createdAt: entry.createdAt, id: entry.id }
      })
      .mockResolvedValueOnce({
        status: 'ok',
        entries: [{ ...entry, id: '22222222-2222-4222-8222-222222222222', term: 'banana' }]
      })
    api.list = list
    render(
      <I18nextProvider i18n={createI18n('en')}>
        <VocabularyPanel api={api} onExit={() => {}} />
      </I18nextProvider>
    )
    await screen.findByRole('alert')
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Load more' }))
    await screen.findByRole('heading', { name: 'banana' })
    expect(list.mock.calls[2][0].cursor).toEqual({ createdAt: entry.createdAt, id: entry.id })
    expect(screen.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument()
  })
  it('only enters vocabulary mode through the picker, preserves state across conversation changes and exits to chat', async () => {
    const api = apiStub()
    Object.defineProperty(window, 'api', { configurable: true, value: { vocabulary: api } })
    const onSend = vi.fn()
    const tree = (
      messages: Parameters<typeof ConversationPanel>[0]['messages'] = []
    ): React.JSX.Element => (
      <I18nextProvider i18n={createI18n('en')}>
        <ConversationPanel
          messages={messages}
          status={{ kind: 'ready' }}
          generating={false}
          composerLocked={false}
          onSend={onSend}
          onCancel={() => {}}
          onRetry={() => {}}
        />
      </I18nextProvider>
    )
    const view = render(tree())
    const chatInput = screen.getByRole('combobox')
    fireEvent.change(chatInput, { target: { value: 'apple, banana' } })
    fireEvent.submit(chatInput.closest('form')!)
    expect(onSend).toHaveBeenCalledWith('apple, banana')
    expect(api.addBatch).not.toHaveBeenCalled()
    fireEvent.focus(chatInput)
    fireEvent.change(chatInput, { target: { value: '/vocabulary' } })
    fireEvent.keyDown(chatInput, { key: 'Enter' })
    const input = await screen.findByRole('textbox', { name: 'Words or phrases' })
    fireEvent.change(input, { target: { value: 'orange' } })
    view.rerender(
      tree([
        {
          messageId: 'new-session-message',
          role: 'user',
          content: 'new session',
          streaming: false,
          retryable: false
        }
      ])
    )
    expect(screen.getByRole('textbox')).toHaveValue('orange')
    fireEvent.click(screen.getByRole('button', { name: 'Exit vocabulary mode' }))
    expect(screen.getByRole('combobox')).toBeInTheDocument()
    expect(
      within(screen.getByRole('region', { name: 'Conversation history' })).getByText('new session')
    ).toBeInTheDocument()
  })
})
