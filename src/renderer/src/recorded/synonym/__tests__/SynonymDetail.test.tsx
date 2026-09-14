// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { I18nextProvider } from 'react-i18next'
import type { SynonymApi, SynonymListResult, SynonymGroup } from '../../../../../shared/synonym'
import { createI18n } from '../../../i18n'
import { SynonymDetail } from '../SynonymDetail'

// 组件测试固定 zh-CN 渲染；断言基于真实资源文本与可访问名称。
const i18n = createI18n('zh-CN')

function entry(
  groupId: string,
  word: string,
  overrides: Partial<{ id: string; meaning: string; distinction: string }> = {}
): SynonymGroup['words'][number] {
  return {
    id: overrides.id ?? `${word}-id`,
    word,
    meaning: overrides.meaning ?? `${word} 的释义`,
    distinction: overrides.distinction ?? `${word} 的区别`,
    groupid: groupId
  }
}

function group(
  id: string,
  meaning: string,
  words: Array<SynonymGroup['words'][number]>
): SynonymGroup {
  return { id, meaning, words }
}

interface SynonymApiStub {
  api: SynonymApi
  calls: { list: number; cursors: unknown[] }
  respondList(result: SynonymListResult): void
}

// 结果按到达顺序排队消费；未预置结果时挂起，模拟慢请求。
function synonymApiStub(initial: SynonymListResult): SynonymApiStub {
  const calls = { list: 0, cursors: [] as unknown[] }
  const queue: Array<Promise<SynonymListResult>> = [Promise.resolve(initial)]
  const api: SynonymApi = {
    async list(input) {
      calls.list += 1
      calls.cursors.push(input)
      return queue.shift() ?? new Promise(() => {})
    }
  }
  return {
    api,
    calls,
    respondList(result) {
      queue.push(Promise.resolve(result))
    }
  }
}

function installApi(api: SynonymApi): void {
  vi.stubGlobal('api', { synonym: api })
}

function renderDetail(): void {
  render(
    <I18nextProvider i18n={i18n}>
      <SynonymDetail />
    </I18nextProvider>
  )
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  void i18n.changeLanguage('zh-CN')
})

describe('SynonymDetail table', () => {
  const singleGroup = group('11111111-1111-4111-8111-111111111111', '尚可', [
    entry('11111111-1111-4111-8111-111111111111', 'adequate')
  ])
  const tripleGroup = group('22222222-2222-4222-8222-222222222222', '足够好', [
    entry('22222222-2222-4222-8222-222222222222', 'sufficient'),
    entry('22222222-2222-4222-8222-222222222222', 'decent'),
    entry('22222222-2222-4222-8222-222222222222', 'acceptable')
  ])

  it('shows the loading state first, then headers in order', async () => {
    installApi(synonymApiStub({ status: 'ok', groups: [singleGroup], nextCursor: null }).api)
    renderDetail()

    expect(screen.getByText('正在加载近义词…')).toBeInTheDocument()
    const table = await screen.findByRole('table')
    expect(table).toHaveAccessibleName('已收藏近义词分组列表')

    const headers = within(within(table).getAllByRole('row')[0]).getAllByRole('columnheader')
    expect(headers.map((header) => header.textContent)).toEqual([
      '分组释义',
      '单词',
      '单词释义',
      '用法区别'
    ])
  })

  it('merges the group meaning cell across rows and renders it once', async () => {
    installApi(
      synonymApiStub({ status: 'ok', groups: [singleGroup, tripleGroup], nextCursor: null }).api
    )
    renderDetail()

    const table = await screen.findByRole('table')
    const sections = within(table).getAllByRole('rowgroup')
    // thead + 每个 group 一个 tbody。
    expect(sections).toHaveLength(3)

    // 单行组：rowSpan 为 1。
    const singleBody = sections[1]
    const singleRows = within(singleBody).getAllByRole('row')
    expect(singleRows).toHaveLength(1)
    const singleMerged = singleRows[0].querySelector('th.synonym-group-meaning')
    expect(singleMerged).not.toBeNull()
    expect(singleMerged).toHaveAttribute('rowspan', '1')
    expect(singleMerged).toHaveTextContent('尚可')

    // 三行组：rowSpan 为 3，只在第一行渲染一次；后续行不补空单元格。
    const tripleBody = sections[2]
    const tripleRows = within(tripleBody).getAllByRole('row')
    expect(tripleRows).toHaveLength(3)
    const tripleMerged = tripleRows[0].querySelector('th.synonym-group-meaning')
    expect(tripleMerged).not.toBeNull()
    expect(tripleMerged).toHaveAttribute('rowspan', '3')
    expect(tripleMerged).toHaveAttribute('scope', 'rowgroup')
    expect(within(tripleRows[0]).getAllByRole('cell')).toHaveLength(3)
    expect(within(tripleRows[1]).getAllByRole('cell')).toHaveLength(3)
    expect(within(tripleRows[2]).getAllByRole('cell')).toHaveLength(3)
    expect(tripleBody.querySelectorAll('th.synonym-group-meaning')).toHaveLength(1)
    expect(within(tripleRows[1]).queryByText('足够好')).not.toBeInTheDocument()
    // 词条按接口返回顺序渲染（组内排序由读取层保证）。
    expect(tripleRows.map((row) => within(row).getAllByRole('cell')[0].textContent)).toEqual([
      'sufficient',
      'decent',
      'acceptable'
    ])
  })

  it('keeps groups with the same meaning but different ids separate', async () => {
    installApi(
      synonymApiStub({
        status: 'ok',
        groups: [
          group('11111111-1111-4111-8111-111111111111', '同义', [
            entry('11111111-1111-4111-8111-111111111111', 'first')
          ]),
          group('22222222-2222-4222-8222-222222222222', '同义', [
            entry('22222222-2222-4222-8222-222222222222', 'second')
          ])
        ],
        nextCursor: null
      }).api
    )
    renderDetail()

    const table = await screen.findByRole('table')
    const bodies = within(table).getAllByRole('rowgroup')
    expect(bodies).toHaveLength(3)
    expect(within(bodies[1]).getByText('first')).toBeInTheDocument()
    expect(within(bodies[2]).getByText('second')).toBeInTheDocument()
    expect(within(table).getAllByText('同义')).toHaveLength(2)
  })

  it('preserves line breaks in meanings and distinctions as data', async () => {
    const multiline = group('11111111-1111-4111-8111-111111111111', '多行', [
      entry('11111111-1111-4111-8111-111111111111', 'adequate', {
        meaning: '第一行。\n第二行。',
        distinction: '区别一。\n区别二。'
      })
    ])
    installApi(synonymApiStub({ status: 'ok', groups: [multiline], nextCursor: null }).api)
    renderDetail()

    const row = await waitFor(() => within(screen.getAllByRole('row')[1]))
    expect(row.getByText(/第一行/).innerHTML).toContain('第一行。\n第二行。')
    expect(row.getByText(/区别一/).innerHTML).toContain('区别一。\n区别二。')
  })

  it('renders headers in English', async () => {
    await i18n.changeLanguage('en')
    installApi(synonymApiStub({ status: 'ok', groups: [singleGroup], nextCursor: null }).api)
    renderDetail()

    const headers = await waitFor(() => {
      const rows = screen.getAllByRole('row')
      return within(rows[0]).getAllByRole('columnheader')
    })
    expect(headers.map((header) => header.textContent)).toEqual([
      'Group meaning',
      'Word',
      'Word meaning',
      'Distinction'
    ])
  })
})

describe('SynonymDetail list states', () => {
  it('shows the empty state when there are no groups and no cursor', async () => {
    installApi(synonymApiStub({ status: 'ok', groups: [], nextCursor: null }).api)
    renderDetail()

    expect(await screen.findByText('还没有收藏近义词')).toBeInTheDocument()
    expect(screen.getByText(/在对话中使用 \/synonym 命令收藏近义词/)).toBeInTheDocument()
    expect(screen.queryByRole('table')).not.toBeInTheDocument()
  })

  it('shows a retryable error when the first load fails', async () => {
    const stub = synonymApiStub({ status: 'error', error: { code: 'STORAGE_FAILED' } })
    installApi(stub.api)
    renderDetail()

    expect(await screen.findByRole('alert')).toHaveTextContent('近义词读取失败')
    expect(screen.getByText('访问本地数据失败，请稍后重试。')).toBeInTheDocument()
    expect(screen.queryByRole('table')).not.toBeInTheDocument()

    stub.respondList({ status: 'ok', groups: [], nextCursor: null })
    fireEvent.click(screen.getByRole('button', { name: '重试' }))
    expect(await screen.findByText('还没有收藏近义词')).toBeInTheDocument()
    expect(stub.calls.list).toBe(2)
  })

  it('appends pages through load more and dedupes repeated groups', async () => {
    const first = group('11111111-1111-4111-8111-111111111111', '第一组', [
      entry('11111111-1111-4111-8111-111111111111', 'adequate')
    ])
    const second = group('22222222-2222-4222-8222-222222222222', '第二组', [
      entry('22222222-2222-4222-8222-222222222222', 'decent')
    ])
    const stub = synonymApiStub({
      status: 'ok',
      groups: [first],
      nextCursor: '33333333-3333-4333-8333-333333333333'
    })
    installApi(stub.api)
    renderDetail()

    const moreButton = await screen.findByRole('button', { name: '加载更多' })
    // 第二页重复返回第一组并带回最后两组：只追加新组。
    stub.respondList({
      status: 'ok',
      groups: [first, second],
      nextCursor: null
    })
    fireEvent.click(moreButton)

    expect(await screen.findByText('decent')).toBeInTheDocument()
    expect(screen.getByText('adequate')).toBeInTheDocument()
    expect(screen.getAllByText('第一组')).toHaveLength(1)
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: '加载更多' })).not.toBeInTheDocument()
    })
    expect(stub.calls.list).toBe(2)
    expect(stub.calls.cursors[1]).toEqual({ cursor: '33333333-3333-4333-8333-333333333333' })
  })

  it('keeps loaded groups when loading more fails and allows retry', async () => {
    const first = group('11111111-1111-4111-8111-111111111111', '第一组', [
      entry('11111111-1111-4111-8111-111111111111', 'adequate')
    ])
    const stub = synonymApiStub({
      status: 'ok',
      groups: [first],
      nextCursor: '33333333-3333-4333-8333-333333333333'
    })
    installApi(stub.api)
    renderDetail()

    const moreButton = await screen.findByRole('button', { name: '加载更多' })
    stub.respondList({ status: 'error', error: { code: 'UNKNOWN_ERROR' } })
    fireEvent.click(moreButton)

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('加载更多失败')
    expect(screen.getByText('adequate')).toBeInTheDocument()

    stub.respondList({
      status: 'ok',
      groups: [
        group('22222222-2222-4222-8222-222222222222', '第二组', [
          entry('22222222-2222-4222-8222-222222222222', 'decent')
        ])
      ],
      nextCursor: null
    })
    fireEvent.click(screen.getByRole('button', { name: '重试' }))
    expect(await screen.findByText('decent')).toBeInTheDocument()
  })

  it('ignores late first-load results after unmount', async () => {
    let release!: (result: SynonymListResult) => void
    const api: SynonymApi = {
      list: () =>
        new Promise<SynonymListResult>((resolve) => {
          release = resolve
        })
    }
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      installApi(api)
      const { unmount } = render(
        <I18nextProvider i18n={i18n}>
          <SynonymDetail />
        </I18nextProvider>
      )
      expect(screen.getByText('正在加载近义词…')).toBeInTheDocument()
      unmount()

      release({ status: 'ok', groups: [], nextCursor: null })
      await Promise.resolve()
      // 卸载后迟到的响应不得触发状态更新（无 React 警告即视为未写入状态）。
      expect(consoleError).not.toHaveBeenCalled()
    } finally {
      consoleError.mockRestore()
    }
  })
})
