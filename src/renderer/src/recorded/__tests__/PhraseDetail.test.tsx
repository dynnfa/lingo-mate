// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { I18nextProvider } from 'react-i18next'
import type {
  DeletePhraseResult,
  ListPhraseResult,
  PhraseApi,
  PhraseEntry
} from '../../../../shared/phrase'
import { createI18n } from '../../i18n'
import { PhraseDetail } from '../PhraseDetail'

// 组件测试固定 zh-CN 渲染；断言基于真实资源文本与可访问名称。
const i18n = createI18n('zh-CN')

let entrySerial = 0
function entry(overrides: Partial<PhraseEntry> = {}): PhraseEntry {
  entrySerial += 1
  return {
    phrase: `phrase ${entrySerial}`,
    explantation: `第 ${entrySerial} 条短语的解释。`,
    example: `Example sentence ${entrySerial}.`,
    ...overrides
  }
}

interface PhraseApiStub {
  api: PhraseApi
  calls: { list: number; deletes: string[] }
  respondList(result: ListPhraseResult): void
  respondDelete(result: DeletePhraseResult): void
}

// 结果按到达顺序排队消费；未预置结果时挂起，模拟慢请求。
function phraseApiStub(initial: ListPhraseResult): PhraseApiStub {
  const calls = { list: 0, deletes: [] as string[] }
  const listQueue: Array<Promise<ListPhraseResult>> = [Promise.resolve(initial)]
  const deleteQueue: Array<Promise<DeletePhraseResult>> = []
  const api: PhraseApi = {
    async list() {
      calls.list += 1
      return listQueue.shift() ?? new Promise(() => {})
    },
    async delete(input) {
      calls.deletes.push(input.phrase)
      return deleteQueue.shift() ?? new Promise(() => {})
    }
  }
  return {
    api,
    calls,
    respondList(result) {
      listQueue.push(Promise.resolve(result))
    },
    respondDelete(result) {
      deleteQueue.push(Promise.resolve(result))
    }
  }
}

function installApi(api: PhraseApi): void {
  vi.stubGlobal('api', { phrase: api })
}

function renderDetail(): void {
  render(
    <I18nextProvider i18n={i18n}>
      <PhraseDetail />
    </I18nextProvider>
  )
}

function deleteButton(phrase: string): HTMLButtonElement {
  return screen.getByRole('button', { name: `删除 ${phrase}` })
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  void i18n.changeLanguage('zh-CN')
})

describe('PhraseDetail table', () => {
  it('shows the loading state first, then rows with columns in order', async () => {
    const saved = entry({
      phrase: 'look forward to',
      explantation: '期待，盼望（某件将发生的事）。',
      example: 'I look forward to hearing from you.'
    })
    installApi(phraseApiStub({ status: 'ok', entries: [saved] }).api)
    renderDetail()

    expect(screen.getByText('正在加载短语…')).toBeInTheDocument()
    const table = await screen.findByRole('table')
    expect(table).toHaveAccessibleName('已收藏短语列表')

    const headers = within(within(table).getAllByRole('row')[0]).getAllByRole('columnheader')
    expect(headers.map((header) => header.textContent)).toEqual(['短语', '解释', '例句', '操作'])

    const row = within(within(table).getAllByRole('row')[1])
    expect(row.getByText('look forward to')).toBeInTheDocument()
    expect(row.getByText('期待，盼望（某件将发生的事）。')).toBeInTheDocument()
    expect(row.getByText('I look forward to hearing from you.')).toBeInTheDocument()
    expect(row.getByRole('button', { name: '删除 look forward to' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '加载更多' })).not.toBeInTheDocument()
  })

  it('preserves line breaks in explanation and example as data', async () => {
    const multiline = entry({
      phrase: 'break even',
      explantation: '收支相抵。\n不赚不赔。',
      example: 'The firm broke even this year.\nSecond line.'
    })
    installApi(phraseApiStub({ status: 'ok', entries: [multiline] }).api)
    renderDetail()

    const row = await waitFor(() => {
      const rows = screen.getAllByRole('row')
      return within(rows[1])
    })
    // 换行作为数据保留在单元格中，由 CSS 按行渲染。
    expect(row.getByText(/收支相抵/).innerHTML).toContain('收支相抵。\n不赚不赔。')
    expect(row.getByText(/broke even this year/).innerHTML).toContain(
      'The firm broke even this year.\nSecond line.'
    )
  })

  it('renders headers in English', async () => {
    await i18n.changeLanguage('en')
    installApi(phraseApiStub({ status: 'ok', entries: [entry()] }).api)
    renderDetail()

    const headers = await waitFor(() => {
      const rows = screen.getAllByRole('row')
      return within(rows[0]).getAllByRole('columnheader')
    })
    expect(headers.map((header) => header.textContent)).toEqual([
      'Phrase',
      'Explanation',
      'Example',
      'Actions'
    ])
  })
})

describe('PhraseDetail list states', () => {
  it('shows the empty state when there are no entries and no cursor', async () => {
    installApi(phraseApiStub({ status: 'ok', entries: [] }).api)
    renderDetail()

    expect(await screen.findByText('还没有收藏短语')).toBeInTheDocument()
    expect(screen.getByText(/在对话中使用 \/phrase 命令收藏短语/)).toBeInTheDocument()
    expect(screen.queryByRole('table')).not.toBeInTheDocument()
  })

  it('shows a retryable error when the first load fails', async () => {
    const stub = phraseApiStub({ status: 'error', error: { code: 'STORAGE_FAILED' } })
    installApi(stub.api)
    renderDetail()

    expect(await screen.findByRole('alert')).toHaveTextContent('短语读取失败')
    expect(screen.getByText('访问本地短语数据失败，请稍后重试。')).toBeInTheDocument()
    expect(screen.queryByRole('table')).not.toBeInTheDocument()

    stub.respondList({ status: 'ok', entries: [entry({ phrase: 'look forward to' })] })
    fireEvent.click(screen.getByRole('button', { name: '重试' }))
    expect(await screen.findByRole('table')).toBeInTheDocument()
    expect(stub.calls.list).toBe(2)
  })

  it('appends pages through load more until the cursor is exhausted', async () => {
    const first = entry({ phrase: 'a phrase' })
    const second = entry({ phrase: 'b phrase' })
    const stub = phraseApiStub({ status: 'ok', entries: [first], nextCursor: first.phrase })
    installApi(stub.api)
    renderDetail()

    const moreButton = await screen.findByRole('button', { name: '加载更多' })
    stub.respondList({ status: 'ok', entries: [second] })
    fireEvent.click(moreButton)

    expect(await screen.findByText('b phrase')).toBeInTheDocument()
    expect(screen.getByText('a phrase')).toBeInTheDocument()
    // 没有后续游标后按钮消失。
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: '加载更多' })).not.toBeInTheDocument()
    })
    expect(stub.calls.list).toBe(2)
  })

  it('keeps existing rows when loading more fails and allows retry', async () => {
    const first = entry({ phrase: 'a phrase' })
    const stub = phraseApiStub({
      status: 'ok',
      entries: [first],
      nextCursor: first.phrase
    })
    installApi(stub.api)
    renderDetail()

    const moreButton = await screen.findByRole('button', { name: '加载更多' })
    stub.respondList({ status: 'error', error: { code: 'STORAGE_FAILED' } })
    fireEvent.click(moreButton)

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('加载更多失败')
    expect(screen.getByText('a phrase')).toBeInTheDocument()

    stub.respondList({ status: 'ok', entries: [entry({ phrase: 'b phrase' })] })
    fireEvent.click(screen.getByRole('button', { name: '重试' }))
    expect(await screen.findByText('b phrase')).toBeInTheDocument()
  })
})

describe('PhraseDetail deletion', () => {
  async function openDialogFor(phrase: string): Promise<void> {
    fireEvent.click(deleteButton(phrase))
    const dialog = await screen.findByRole('dialog')
    expect(dialog).toHaveTextContent('将删除收藏记录')
    expect(dialog).toHaveTextContent(phrase)
    expect(within(dialog).getByRole('button', { name: '取消' })).toHaveFocus()
  }

  it('cancels the dialog without deleting and restores focus', async () => {
    const saved = entry({ phrase: 'look forward to' })
    installApi(phraseApiStub({ status: 'ok', entries: [saved] }).api)
    renderDetail()
    await screen.findByText('look forward to')

    await openDialogFor('look forward to')
    fireEvent.click(screen.getByRole('button', { name: '取消' }))

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(screen.getByText('look forward to')).toBeInTheDocument()
    expect(deleteButton('look forward to')).toHaveFocus()
  })

  it('closes the dialog with Escape and restores focus', async () => {
    const saved = entry({ phrase: 'look forward to' })
    installApi(phraseApiStub({ status: 'ok', entries: [saved] }).api)
    renderDetail()
    await screen.findByText('look forward to')

    fireEvent.click(deleteButton('look forward to'))
    const dialog = await screen.findByRole('dialog')
    fireEvent.keyDown(dialog, { key: 'Escape' })

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(screen.getByText('look forward to')).toBeInTheDocument()
    expect(deleteButton('look forward to')).toHaveFocus()
  })

  it('removes the row after confirmation, announces it, and focuses the next row', async () => {
    const first = entry({ phrase: 'a phrase' })
    const second = entry({ phrase: 'b phrase' })
    const stub = phraseApiStub({ status: 'ok', entries: [first, second] })
    installApi(stub.api)
    renderDetail()
    await screen.findByText('a phrase')

    await openDialogFor('a phrase')
    stub.respondDelete({ status: 'ok', phrase: first.phrase, deleted: true })
    fireEvent.click(screen.getByRole('button', { name: '删除' }))

    await waitFor(() => {
      expect(screen.queryByText('a phrase')).not.toBeInTheDocument()
    })
    expect(screen.getByText('b phrase')).toBeInTheDocument()
    expect(screen.getByText('已删除「a phrase」')).toBeInTheDocument()
    expect(deleteButton('b phrase')).toHaveFocus()
    expect(stub.calls.deletes).toEqual([first.phrase])
  })

  it('focuses the detail heading after the last row is deleted', async () => {
    const saved = entry({ phrase: 'a phrase' })
    const stub = phraseApiStub({ status: 'ok', entries: [saved] })
    installApi(stub.api)
    renderDetail()
    await screen.findByText('a phrase')

    fireEvent.click(deleteButton('a phrase'))
    await screen.findByRole('dialog')
    stub.respondDelete({ status: 'ok', phrase: saved.phrase, deleted: true })
    fireEvent.click(screen.getByRole('button', { name: '删除' }))

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    })
    // 没有行且没有游标：空短语库状态。
    expect(await screen.findByText('还没有收藏短语')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: '短语' })).toHaveFocus()
  })

  it('treats an already-missing record as success and removes the stale row', async () => {
    const first = entry({ phrase: 'a phrase' })
    const second = entry({ phrase: 'b phrase' })
    const stub = phraseApiStub({
      status: 'ok',
      entries: [first, second],
      nextCursor: first.phrase
    })
    installApi(stub.api)
    renderDetail()
    await screen.findByText('a phrase')

    fireEvent.click(deleteButton('a phrase'))
    await screen.findByRole('dialog')
    stub.respondDelete({ status: 'ok', phrase: first.phrase, deleted: false })
    fireEvent.click(screen.getByRole('button', { name: '删除' }))

    await waitFor(() => {
      expect(screen.queryByText('a phrase')).not.toBeInTheDocument()
    })
    // 已加载行全部删除但仍有游标：继续提供加载更多，不落入空短语库。
    expect(await screen.findByRole('button', { name: '加载更多' })).toBeInTheDocument()
  })

  it('keeps the row and shows a safe error when deletion fails, then retries', async () => {
    const saved = entry({ phrase: 'a phrase' })
    const stub = phraseApiStub({ status: 'ok', entries: [saved] })
    installApi(stub.api)
    renderDetail()
    await screen.findByText('a phrase')

    fireEvent.click(deleteButton('a phrase'))
    await screen.findByRole('dialog')
    stub.respondDelete({ status: 'error', error: { code: 'STORAGE_FAILED' } })
    fireEvent.click(screen.getByRole('button', { name: '删除' }))

    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByRole('alert')).toHaveTextContent('访问本地短语数据失败')
    expect(screen.getByText('a phrase')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '删除中…' })).not.toBeInTheDocument()

    stub.respondDelete({ status: 'ok', phrase: saved.phrase, deleted: true })
    fireEvent.click(within(dialog).getByRole('button', { name: '删除' }))
    await waitFor(() => {
      expect(screen.queryByText('a phrase')).not.toBeInTheDocument()
    })
    expect(stub.calls.deletes).toEqual([saved.phrase, saved.phrase])
  })

  it('disables repeated submission while a deletion is in flight', async () => {
    const saved = entry({ phrase: 'a phrase' })
    const stub = phraseApiStub({ status: 'ok', entries: [saved] })
    installApi(stub.api)
    renderDetail()
    await screen.findByText('a phrase')

    fireEvent.click(deleteButton('a phrase'))
    await screen.findByRole('dialog')
    // 不预置删除结果：确认后请求挂起，按钮进入进行中并禁用。
    fireEvent.click(screen.getByRole('button', { name: '删除' }))

    const inFlight = await screen.findByRole('button', { name: '删除中…' })
    expect(inFlight).toBeDisabled()
    expect(screen.getByRole('button', { name: '取消' })).toBeDisabled()
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(stub.calls.deletes).toEqual([saved.phrase])
  })

  it('ignores late list results that would resurrect deleted phrases', async () => {
    const first = entry({ phrase: 'a phrase' })
    const second = entry({ phrase: 'b phrase' })
    const stub = phraseApiStub({
      status: 'ok',
      entries: [first, second],
      nextCursor: first.phrase
    })
    installApi(stub.api)
    renderDetail()
    await screen.findByText('a phrase')

    // 加载更多挂起期间删除 a phrase：慢响应携带的过期快照不得让短语复活。
    fireEvent.click(deleteButton('a phrase'))
    await screen.findByRole('dialog')
    stub.respondDelete({ status: 'ok', phrase: first.phrase, deleted: true })
    fireEvent.click(screen.getByRole('button', { name: '删除' }))
    await waitFor(() => {
      expect(screen.queryByText('a phrase')).not.toBeInTheDocument()
    })

    stub.respondList({ status: 'ok', entries: [first, entry({ phrase: 'c phrase' })] })
    fireEvent.click(screen.getByRole('button', { name: '加载更多' }))

    expect(await screen.findByText('c phrase')).toBeInTheDocument()
    expect(screen.queryByText('a phrase')).not.toBeInTheDocument()
    expect(screen.getByText('b phrase')).toBeInTheDocument()
  })
})
