// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { I18nextProvider } from 'react-i18next'
import type {
  DeleteVocabularyResult,
  ListVocabularyResult,
  VocabularyApi,
  VocabularyEntry
} from '../../../../../shared/vocabulary'
import { createI18n } from '../../../i18n'
import { VocabularyDetail } from '../VocabularyDetail'

// 组件测试固定 zh-CN 渲染；断言基于真实资源文本与可访问名称。
const i18n = createI18n('zh-CN')

let entrySerial = 0
function entry(overrides: Partial<VocabularyEntry> = {}): VocabularyEntry {
  entrySerial += 1
  return {
    id: `10000000-0000-4000-8000-${String(entrySerial).padStart(12, '0')}`,
    term: `word-${entrySerial}`,
    phonetic: `/wɜːd ${entrySerial}/`,
    meaning: `第 ${entrySerial} 个词的释义。`,
    concept: `第 ${entrySerial} 个词的概念说明。`,
    exampleSentences: [`Sentence one about ${entrySerial}.`, `Sentence two about ${entrySerial}.`],
    createdAt: '2026-09-07T00:00:00.000Z',
    ...overrides
  }
}

interface VocabularyApiStub {
  api: VocabularyApi
  calls: { list: number; deletes: string[] }
  respondList(result: ListVocabularyResult): void
  respondDelete(result: DeleteVocabularyResult): void
}

// 结果按到达顺序排队消费；未预置结果时挂起，模拟慢请求。
function vocabularyApiStub(initial: ListVocabularyResult): VocabularyApiStub {
  const calls = { list: 0, deletes: [] as string[] }
  const listQueue: Array<Promise<ListVocabularyResult>> = [Promise.resolve(initial)]
  const deleteQueue: Array<Promise<DeleteVocabularyResult>> = []
  const api: VocabularyApi = {
    async list() {
      calls.list += 1
      return listQueue.shift() ?? new Promise(() => {})
    },
    async delete(input) {
      calls.deletes.push(input.id)
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

function installApi(api: VocabularyApi): void {
  vi.stubGlobal('api', { vocabulary: api })
}

function renderDetail(): void {
  render(
    <I18nextProvider i18n={i18n}>
      <VocabularyDetail />
    </I18nextProvider>
  )
}

function deleteButton(term: string): HTMLButtonElement {
  return screen.getByRole('button', { name: `删除 ${term}` })
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  void i18n.changeLanguage('zh-CN')
})

describe('VocabularyDetail table', () => {
  it('shows the loading state first, then rows with columns in order', async () => {
    const apple = entry({ term: 'apple', phonetic: '/ˈæpəl/', meaning: '苹果，一种水果。' })
    const stub = vocabularyApiStub({ status: 'ok', entries: [apple] })
    installApi(stub.api)
    renderDetail()

    expect(screen.getByText('正在加载词汇…')).toBeInTheDocument()
    const table = await screen.findByRole('table')
    expect(table).toHaveAccessibleName('已收藏词汇列表')

    const headers = within(within(table).getAllByRole('row')[0]).getAllByRole('columnheader')
    expect(headers.map((header) => header.textContent)).toEqual([
      '单词',
      '音标',
      '释义',
      '概念说明',
      '例句',
      '操作'
    ])

    const row = within(within(table).getAllByRole('row')[1])
    expect(row.getByText('apple')).toBeInTheDocument()
    expect(row.getByText('/ˈæpəl/')).toBeInTheDocument()
    expect(row.getByText('苹果，一种水果。')).toBeInTheDocument()
    for (const sentence of apple.exampleSentences ?? []) {
      expect(row.getByText(sentence)).toBeInTheDocument()
    }
    expect(row.getByRole('button', { name: '删除 apple' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '加载更多' })).not.toBeInTheDocument()
  })

  it('uses the shared placeholder for missing content and preserves line breaks as data', async () => {
    const legacy = entry({
      term: 'banana',
      phonetic: null,
      meaning: '香蕉。\n多年生草本植物。',
      concept: null,
      exampleSentences: null
    })
    installApi(vocabularyApiStub({ status: 'ok', entries: [legacy] }).api)
    renderDetail()

    const row = await waitFor(() => {
      const rows = screen.getAllByRole('row')
      return within(rows[1])
    })
    const placeholders = row.getAllByText('—')
    // 音标、概念说明、例句三个缺失字段共用占位。
    expect(placeholders).toHaveLength(3)
    // 释义的换行作为数据保留在单元格中，由 CSS 按行渲染。
    expect(row.getByText(/香蕉/).innerHTML).toContain('香蕉。\n多年生草本植物。')
  })

  it('renders headers in English', async () => {
    await i18n.changeLanguage('en')
    installApi(vocabularyApiStub({ status: 'ok', entries: [entry({ term: 'apple' })] }).api)
    renderDetail()

    const headers = await waitFor(() => {
      const rows = screen.getAllByRole('row')
      return within(rows[0]).getAllByRole('columnheader')
    })
    expect(headers.map((header) => header.textContent)).toEqual([
      'Word',
      'Phonetic',
      'Meaning',
      'Concept',
      'Examples',
      'Actions'
    ])
  })
})

describe('VocabularyDetail list states', () => {
  it('shows the empty state when there are no entries and no cursor', async () => {
    installApi(vocabularyApiStub({ status: 'ok', entries: [] }).api)
    renderDetail()

    expect(await screen.findByText('还没有收藏词汇')).toBeInTheDocument()
    expect(screen.getByText(/在对话中使用 \/vocabulary 命令收藏单词/)).toBeInTheDocument()
    expect(screen.queryByRole('table')).not.toBeInTheDocument()
  })

  it('shows a retryable error when the first load fails', async () => {
    const stub = vocabularyApiStub({ status: 'error', error: { code: 'STORAGE_FAILED' } })
    installApi(stub.api)
    renderDetail()

    expect(await screen.findByRole('alert')).toHaveTextContent('词汇读取失败')
    expect(screen.getByText('访问本地词汇数据失败，请稍后重试。')).toBeInTheDocument()
    expect(screen.queryByRole('table')).not.toBeInTheDocument()

    stub.respondList({ status: 'ok', entries: [entry({ term: 'apple' })] })
    fireEvent.click(screen.getByRole('button', { name: '重试' }))
    expect(await screen.findByRole('table')).toBeInTheDocument()
    expect(stub.calls.list).toBe(2)
  })

  it('appends pages through load more until the cursor is exhausted', async () => {
    const first = entry({ term: 'first' })
    const second = entry({ term: 'second' })
    const firstCursor = { createdAt: first.createdAt, id: first.id }
    const stub = vocabularyApiStub({
      status: 'ok',
      entries: [first],
      nextCursor: firstCursor
    })
    installApi(stub.api)
    renderDetail()

    const moreButton = await screen.findByRole('button', { name: '加载更多' })
    stub.respondList({ status: 'ok', entries: [second] })
    fireEvent.click(moreButton)

    expect(await screen.findByText('second')).toBeInTheDocument()
    expect(screen.getByText('first')).toBeInTheDocument()
    // 没有后续游标后按钮消失。
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: '加载更多' })).not.toBeInTheDocument()
    })
    expect(stub.calls.list).toBe(2)
  })

  it('keeps existing rows when loading more fails and allows retry', async () => {
    const first = entry({ term: 'first' })
    const stub = vocabularyApiStub({
      status: 'ok',
      entries: [first],
      nextCursor: { createdAt: first.createdAt, id: first.id }
    })
    installApi(stub.api)
    renderDetail()

    const moreButton = await screen.findByRole('button', { name: '加载更多' })
    stub.respondList({ status: 'error', error: { code: 'STORAGE_FAILED' } })
    fireEvent.click(moreButton)

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('加载更多失败')
    expect(screen.getByText('first')).toBeInTheDocument()

    stub.respondList({ status: 'ok', entries: [entry({ term: 'second' })] })
    fireEvent.click(screen.getByRole('button', { name: '重试' }))
    expect(await screen.findByText('second')).toBeInTheDocument()
  })
})

describe('VocabularyDetail deletion', () => {
  async function openDialogFor(term: string): Promise<void> {
    fireEvent.click(deleteButton(term))
    const dialog = await screen.findByRole('dialog')
    expect(dialog).toHaveTextContent('将删除收藏记录')
    expect(dialog).toHaveTextContent(term)
    expect(within(dialog).getByRole('button', { name: '取消' })).toHaveFocus()
  }

  it('cancels the dialog without deleting and restores focus', async () => {
    const apple = entry({ term: 'apple' })
    installApi(vocabularyApiStub({ status: 'ok', entries: [apple] }).api)
    renderDetail()
    await screen.findByText('apple')

    await openDialogFor('apple')
    fireEvent.click(screen.getByRole('button', { name: '取消' }))

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(screen.getByText('apple')).toBeInTheDocument()
    expect(deleteButton('apple')).toHaveFocus()
  })

  it('closes the dialog with Escape and restores focus', async () => {
    const apple = entry({ term: 'apple' })
    installApi(vocabularyApiStub({ status: 'ok', entries: [apple] }).api)
    renderDetail()
    await screen.findByText('apple')

    fireEvent.click(deleteButton('apple'))
    const dialog = await screen.findByRole('dialog')
    fireEvent.keyDown(dialog, { key: 'Escape' })

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(screen.getByText('apple')).toBeInTheDocument()
    expect(deleteButton('apple')).toHaveFocus()
  })

  it('removes the row after confirmation, announces it, and focuses the next row', async () => {
    const apple = entry({ term: 'apple' })
    const banana = entry({ term: 'banana' })
    const stub = vocabularyApiStub({ status: 'ok', entries: [apple, banana] })
    installApi(stub.api)
    renderDetail()
    await screen.findByText('apple')

    await openDialogFor('apple')
    stub.respondDelete({ status: 'ok', id: apple.id, deleted: true })
    fireEvent.click(screen.getByRole('button', { name: '删除' }))

    await waitFor(() => {
      expect(screen.queryByText('apple')).not.toBeInTheDocument()
    })
    expect(screen.getByText('banana')).toBeInTheDocument()
    expect(screen.getByText('已删除「apple」')).toBeInTheDocument()
    expect(deleteButton('banana')).toHaveFocus()
    expect(stub.calls.deletes).toEqual([apple.id])
  })

  it('focuses the detail heading after the last row is deleted', async () => {
    const apple = entry({ term: 'apple' })
    const stub = vocabularyApiStub({ status: 'ok', entries: [apple] })
    installApi(stub.api)
    renderDetail()
    await screen.findByText('apple')

    fireEvent.click(deleteButton('apple'))
    await screen.findByRole('dialog')
    stub.respondDelete({ status: 'ok', id: apple.id, deleted: true })
    fireEvent.click(screen.getByRole('button', { name: '删除' }))

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    })
    // 没有行且没有游标：空词库状态。
    expect(await screen.findByText('还没有收藏词汇')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: '词汇' })).toHaveFocus()
  })

  it('treats an already-missing record as success and removes the stale row', async () => {
    const apple = entry({ term: 'apple' })
    const banana = entry({ term: 'banana' })
    const stub = vocabularyApiStub({
      status: 'ok',
      entries: [apple, banana],
      nextCursor: { createdAt: apple.createdAt, id: apple.id }
    })
    installApi(stub.api)
    renderDetail()
    await screen.findByText('apple')

    fireEvent.click(deleteButton('apple'))
    await screen.findByRole('dialog')
    stub.respondDelete({ status: 'ok', id: apple.id, deleted: false })
    fireEvent.click(screen.getByRole('button', { name: '删除' }))

    await waitFor(() => {
      expect(screen.queryByText('apple')).not.toBeInTheDocument()
    })
    // 已加载行全部删除但仍有游标：继续提供加载更多，不落入空词库。
    expect(await screen.findByRole('button', { name: '加载更多' })).toBeInTheDocument()
  })

  it('keeps the row and shows a safe error when deletion fails, then retries', async () => {
    const apple = entry({ term: 'apple' })
    const stub = vocabularyApiStub({ status: 'ok', entries: [apple] })
    installApi(stub.api)
    renderDetail()
    await screen.findByText('apple')

    fireEvent.click(deleteButton('apple'))
    await screen.findByRole('dialog')
    stub.respondDelete({ status: 'error', error: { code: 'STORAGE_FAILED' } })
    fireEvent.click(screen.getByRole('button', { name: '删除' }))

    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByRole('alert')).toHaveTextContent('访问本地词汇数据失败')
    expect(screen.getByText('apple')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '删除中…' })).not.toBeInTheDocument()

    stub.respondDelete({ status: 'ok', id: apple.id, deleted: true })
    fireEvent.click(within(dialog).getByRole('button', { name: '删除' }))
    await waitFor(() => {
      expect(screen.queryByText('apple')).not.toBeInTheDocument()
    })
    expect(stub.calls.deletes).toEqual([apple.id, apple.id])
  })

  it('disables repeated submission while a deletion is in flight', async () => {
    const apple = entry({ term: 'apple' })
    const stub = vocabularyApiStub({ status: 'ok', entries: [apple] })
    installApi(stub.api)
    renderDetail()
    await screen.findByText('apple')

    fireEvent.click(deleteButton('apple'))
    await screen.findByRole('dialog')
    // 不预置删除结果：确认后请求挂起，按钮进入进行中并禁用。
    fireEvent.click(screen.getByRole('button', { name: '删除' }))

    const inFlight = await screen.findByRole('button', { name: '删除中…' })
    expect(inFlight).toBeDisabled()
    expect(screen.getByRole('button', { name: '取消' })).toBeDisabled()
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(stub.calls.deletes).toEqual([apple.id])
  })

  it('ignores late list results that would resurrect deleted entries', async () => {
    const first = entry({ term: 'first' })
    const second = entry({ term: 'second' })
    const stub = vocabularyApiStub({
      status: 'ok',
      entries: [first, second],
      nextCursor: { createdAt: first.createdAt, id: first.id }
    })
    installApi(stub.api)
    renderDetail()
    await screen.findByText('first')

    // 加载更多挂起期间删除 first：慢响应携带的过期快照不得让词条复活。
    fireEvent.click(deleteButton('first'))
    await screen.findByRole('dialog')
    stub.respondDelete({ status: 'ok', id: first.id, deleted: true })
    fireEvent.click(screen.getByRole('button', { name: '删除' }))
    await waitFor(() => {
      expect(screen.queryByText('first')).not.toBeInTheDocument()
    })

    stub.respondList({ status: 'ok', entries: [first, entry({ term: 'third' })] })
    fireEvent.click(screen.getByRole('button', { name: '加载更多' }))

    expect(await screen.findByText('third')).toBeInTheDocument()
    expect(screen.queryByText('first')).not.toBeInTheDocument()
    expect(screen.getByText('second')).toBeInTheDocument()
  })
})
