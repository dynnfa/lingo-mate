// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { I18nextProvider } from 'react-i18next'
import type {
  ListVocabularyMistakeHistoryResult,
  ListVocabularyMistakesResult,
  VocabularyMistakesApi,
  VocabularyMistakeHistoryItem,
  VocabularyMistakeListItem
} from '../../../../../shared/vocabulary-mistakes'
import { createI18n } from '../../../i18n'
import { VocabularyMistakesDetail } from '../VocabularyMistakesDetail'

// 组件测试固定 zh-CN 渲染；断言基于真实资源文本与可访问名称。
const i18n = createI18n('zh-CN')

const STAMP = '2026-09-20T12:00:00.000Z'
const STAMP_LATER = '2026-09-21T08:30:00.000Z'

let entrySerial = 0
function item(overrides: Partial<VocabularyMistakeListItem> = {}): VocabularyMistakeListItem {
  entrySerial += 1
  return {
    entryId: `10000000-0000-4000-8000-${String(entrySerial).padStart(12, '0')}`,
    term: `word-${entrySerial}`,
    lastSubmittedMeaning: `第 ${entrySerial} 次答错的释义`,
    totalMistakes: 1,
    lastErrorAt: STAMP,
    ...overrides
  }
}

function historyItem(id: string, meaning: string, createdAt = STAMP): VocabularyMistakeHistoryItem {
  return { id, submittedMeaning: meaning, createdAt }
}

interface MistakesApiStub {
  api: VocabularyMistakesApi
  calls: { list: number; listHistory: string[] }
  respondList(result: ListVocabularyMistakesResult): void
  respondHistory(result: ListVocabularyMistakeHistoryResult): void
}

// 结果按到达顺序排队消费；未预置结果时挂起，模拟慢请求。
function mistakesApiStub(initial: ListVocabularyMistakesResult): MistakesApiStub {
  const calls = { list: 0, listHistory: [] as string[] }
  const listQueue: Array<Promise<ListVocabularyMistakesResult>> = [Promise.resolve(initial)]
  const historyQueue: Array<Promise<ListVocabularyMistakeHistoryResult>> = []
  const api: VocabularyMistakesApi = {
    async list(input) {
      calls.list += 1
      return input.cursor
        ? (listQueue.shift() ?? new Promise(() => {}))
        : (listQueue.shift() ?? new Promise(() => {}))
    },
    async listHistory(input) {
      calls.listHistory.push(input.entryId)
      return historyQueue.shift() ?? new Promise(() => {})
    }
  }
  return {
    api,
    calls,
    respondList(result) {
      listQueue.push(Promise.resolve(result))
    },
    respondHistory(result) {
      historyQueue.push(Promise.resolve(result))
    }
  }
}

function installApi(api: VocabularyMistakesApi): void {
  vi.stubGlobal('api', { vocabularyMistakes: api })
}

function renderDetail(): void {
  render(
    <I18nextProvider i18n={i18n}>
      <VocabularyMistakesDetail />
    </I18nextProvider>
  )
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('VocabularyMistakesDetail', () => {
  it('renders aggregated rows with meaning, count and time', async () => {
    const rows = [
      item({ term: 'apple', lastSubmittedMeaning: '一种电脑', totalMistakes: 3 }),
      item({ term: 'banana', totalMistakes: 1, lastErrorAt: STAMP_LATER })
    ]
    installApi(mistakesApiStub({ status: 'ok', entries: rows }).api)
    renderDetail()

    expect(await screen.findByRole('table', { name: '单词错题列表' })).toBeInTheDocument()
    expect(screen.getByText('apple')).toBeInTheDocument()
    expect(screen.getByText('一种电脑')).toBeInTheDocument()
    expect(screen.getByText('3 次')).toBeInTheDocument()
    expect(screen.getByText('1 次')).toBeInTheDocument()
    // ISO 时间保留在 dateTime 属性，展示文本按界面语言格式化
    const bananaRow = screen.getByText('banana').closest('tr') as HTMLElement
    const time = within(bananaRow).getByText((_, element) => element?.tagName === 'TIME')
    expect(time).toHaveAttribute('datetime', STAMP_LATER)
    expect(time.textContent).not.toBe('')
  })

  it('shows the empty state when there are no mistakes', async () => {
    installApi(mistakesApiStub({ status: 'ok', entries: [] }).api)
    renderDetail()

    expect(await screen.findByText('还没有错题')).toBeInTheDocument()
    expect(screen.getByText('完成词汇练习后，答错的单词会自动收集到这里。')).toBeInTheDocument()
  })

  it('shows a retryable error when the first page fails', async () => {
    const stub = mistakesApiStub({ status: 'error', error: { code: 'STORAGE_FAILED' } })
    installApi(stub.api)
    renderDetail()

    expect(await screen.findByText('错题加载失败')).toBeInTheDocument()
    stub.respondList({ status: 'ok', entries: [item({ term: 'apple' })] })
    fireEvent.click(screen.getByRole('button', { name: '重试' }))

    expect(await screen.findByText('apple')).toBeInTheDocument()
    expect(stub.calls.list).toBe(2)
  })

  it('loads more aggregate pages through the cursor', async () => {
    const first = item({ term: 'apple' })
    const second = item({ term: 'banana' })
    const stub = mistakesApiStub({
      status: 'ok',
      entries: [first],
      nextCursor: { lastErrorAt: STAMP, entryId: first.entryId }
    })
    installApi(stub.api)
    renderDetail()

    expect(await screen.findByText('apple')).toBeInTheDocument()
    stub.respondList({ status: 'ok', entries: [second] })
    fireEvent.click(screen.getByRole('button', { name: '加载更多' }))

    expect(await screen.findByText('banana')).toBeInTheDocument()
  })

  it('expands a row to load its paged history and collapses to discard it', async () => {
    const row = item({ term: 'apple', totalMistakes: 2 })
    const stub = mistakesApiStub({ status: 'ok', entries: [row] })
    installApi(stub.api)
    renderDetail()

    expect(await screen.findByText('apple')).toBeInTheDocument()
    const expand = screen.getByRole('button', { name: '查看“apple”的错误历史' })
    expect(expand).toHaveAttribute('aria-expanded', 'false')

    stub.respondHistory({
      status: 'ok',
      items: [historyItem('20000000-0000-4000-8000-000000000002', '第一次答错')],
      nextCursor: { createdAt: STAMP, id: '20000000-0000-4000-8000-000000000002' }
    })
    fireEvent.click(expand)

    const history = await screen.findByRole('group', { name: '“apple”的错误历史' })
    expect(within(history).getByText('第一次答错')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '收起“apple”的错误历史' })).toHaveAttribute(
      'aria-expanded',
      'true'
    )
    expect(stub.calls.listHistory).toEqual([row.entryId])

    // 历史分页：追加第二页
    stub.respondHistory({
      status: 'ok',
      items: [historyItem('20000000-0000-4000-8000-000000000001', '第二次答错')]
    })
    fireEvent.click(within(history).getByRole('button', { name: '加载更多历史' }))
    expect(await within(history).findByText('第二次答错')).toBeInTheDocument()

    // 收起：历史区域移除，状态丢弃
    fireEvent.click(screen.getByRole('button', { name: '收起“apple”的错误历史' }))
    expect(screen.queryByRole('group', { name: '“apple”的错误历史' })).not.toBeInTheDocument()

    // 重新展开：重新读取首屏历史
    stub.respondHistory({
      status: 'ok',
      items: [historyItem('20000000-0000-4000-8000-000000000003', '第三次答错')]
    })
    fireEvent.click(screen.getByRole('button', { name: '查看“apple”的错误历史' }))
    const reloaded = await screen.findByRole('group', { name: '“apple”的错误历史' })
    expect(within(reloaded).getByText('第三次答错')).toBeInTheDocument()
    // 三次调用：首屏、追加一页、收起后重新展开的首屏
    expect(stub.calls.listHistory).toEqual([row.entryId, row.entryId, row.entryId])
  })

  it('ignores an earlier history failure after collapsing and reopening the row', async () => {
    const row = item({ term: 'apple' })
    let resolveEarlier!: (result: ListVocabularyMistakeHistoryResult) => void
    const earlier = new Promise<ListVocabularyMistakeHistoryResult>((resolve) => {
      resolveEarlier = resolve
    })
    const listHistory = vi
      .fn<VocabularyMistakesApi['listHistory']>()
      .mockReturnValueOnce(earlier)
      .mockResolvedValueOnce({
        status: 'ok',
        items: [historyItem('20000000-0000-4000-8000-000000000004', '重新展开后的释义')]
      })
    installApi({
      list: async () => ({ status: 'ok', entries: [row] }),
      listHistory
    })
    renderDetail()

    expect(await screen.findByText('apple')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '查看“apple”的错误历史' }))
    fireEvent.click(screen.getByRole('button', { name: '收起“apple”的错误历史' }))
    fireEvent.click(screen.getByRole('button', { name: '查看“apple”的错误历史' }))

    const history = await screen.findByRole('group', { name: '“apple”的错误历史' })
    expect(await within(history).findByText('重新展开后的释义')).toBeInTheDocument()

    await act(async () => {
      resolveEarlier({ status: 'error', error: { code: 'STORAGE_FAILED' } })
      await earlier
    })
    expect(within(history).queryByText('错误历史加载失败')).not.toBeInTheDocument()
    expect(within(history).getByText('重新展开后的释义')).toBeInTheDocument()
  })

  it('offers retry when the first history page fails', async () => {
    const row = item({ term: 'apple' })
    const stub = mistakesApiStub({ status: 'ok', entries: [row] })
    installApi(stub.api)
    renderDetail()

    expect(await screen.findByText('apple')).toBeInTheDocument()
    stub.respondHistory({ status: 'error', error: { code: 'STORAGE_FAILED' } })
    fireEvent.click(screen.getByRole('button', { name: '查看“apple”的错误历史' }))

    const history = await screen.findByRole('group', { name: '“apple”的错误历史' })
    expect(within(history).getByText('错误历史加载失败')).toBeInTheDocument()

    stub.respondHistory({
      status: 'ok',
      items: [historyItem('20000000-0000-4000-8000-000000000009', '重试后的释义')]
    })
    fireEvent.click(within(history).getByRole('button', { name: '重试' }))
    await waitFor(() => expect(within(history).getByText('重试后的释义')).toBeInTheDocument())
  })

  it('keeps shown history items when loading more fails', async () => {
    const row = item({ term: 'apple' })
    const stub = mistakesApiStub({ status: 'ok', entries: [row] })
    installApi(stub.api)
    renderDetail()

    expect(await screen.findByText('apple')).toBeInTheDocument()
    stub.respondHistory({
      status: 'ok',
      items: [historyItem('20000000-0000-4000-8000-000000000002', '第一次答错')],
      nextCursor: { createdAt: STAMP, id: '20000000-0000-4000-8000-000000000002' }
    })
    fireEvent.click(screen.getByRole('button', { name: '查看“apple”的错误历史' }))
    const history = await screen.findByRole('group', { name: '“apple”的错误历史' })
    expect(within(history).getByText('第一次答错')).toBeInTheDocument()

    stub.respondHistory({ status: 'error', error: { code: 'STORAGE_FAILED' } })
    fireEvent.click(within(history).getByRole('button', { name: '加载更多历史' }))

    expect(await within(history).findByText('加载更多历史失败')).toBeInTheDocument()
    expect(within(history).getByText('第一次答错')).toBeInTheDocument()

    // 追加失败可重试，重试成功后继续追加
    stub.respondHistory({
      status: 'ok',
      items: [historyItem('20000000-0000-4000-8000-000000000001', '第二次答错')]
    })
    fireEvent.click(within(history).getByRole('button', { name: '重试' }))
    expect(await within(history).findByText('第二次答错')).toBeInTheDocument()
  })

  it('renders long meanings with line breaks preserved', async () => {
    const row = item({ term: 'apple', lastSubmittedMeaning: '第一行\n第二行' })
    installApi(mistakesApiStub({ status: 'ok', entries: [row] }).api)
    renderDetail()

    await screen.findByText('apple')
    const cell = document.querySelector('.vocabulary-mistakes-meaning')
    console.log('DEBUG cell text:', JSON.stringify(cell?.textContent))
    expect(cell?.textContent).toBe('第一行\n第二行')
  })
})
