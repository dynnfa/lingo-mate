// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { I18nextProvider } from 'react-i18next'
import type {
  VocabularyPracticeApi,
  VocabularyPracticeReviewResult,
  VocabularyPracticeStartResult
} from '../../../../../shared/vocabulary-practice'
import { createI18n } from '../../../i18n'
import { VocabularyPracticeDetail } from '../VocabularyPracticeDetail'

// 组件测试固定 zh-CN 渲染；断言基于真实资源文本与可访问名称。
const i18n = createI18n('zh-CN')

let entrySerial = 0
function entryId(): string {
  entrySerial += 1
  return `10000000-0000-4000-8000-${String(entrySerial).padStart(12, '0')}`
}

function startOk(terms: string[]): VocabularyPracticeStartResult {
  return {
    status: 'ok',
    sessionId: '20000000-0000-4000-8000-000000000001',
    requestedCount: terms.length,
    actualCount: terms.length,
    entries: terms.map((term) => ({ entryId: entryId(), term }))
  }
}

interface PracticeApiStub {
  api: VocabularyPracticeApi
  calls: {
    starts: number[]
    reviews: Array<{ sessionId: string; answers: Array<{ entryId: string; meaning: string }> }>
    cancels: string[]
  }
  respondStart(result: VocabularyPracticeStartResult): void
  respondReview(result: VocabularyPracticeReviewResult): void
}

// 结果按到达顺序消费；没有排队结果时挂起并记录 resolver，
// 让用例可以在请求发出之后再决定响应（例如取消后补 CANCELLED）。
function practiceApiStub(initial?: VocabularyPracticeStartResult): PracticeApiStub {
  const calls = {
    starts: [] as number[],
    reviews: [] as PracticeApiStub['calls']['reviews'],
    cancels: [] as string[]
  }
  const startQueue: Array<VocabularyPracticeStartResult> = initial ? [initial] : []
  const reviewQueue: Array<VocabularyPracticeReviewResult> = []
  let pendingStart: ((result: VocabularyPracticeStartResult) => void) | undefined
  let pendingReview: ((result: VocabularyPracticeReviewResult) => void) | undefined
  const api: VocabularyPracticeApi = {
    async start(input) {
      calls.starts.push(input.count)
      const queued = startQueue.shift()
      if (queued) return queued
      return new Promise((resolve) => {
        pendingStart = resolve
      })
    },
    async review(input) {
      calls.reviews.push({ sessionId: input.sessionId, answers: input.answers })
      const queued = reviewQueue.shift()
      if (queued) return queued
      return new Promise((resolve) => {
        pendingReview = resolve
      })
    },
    async cancel(input) {
      calls.cancels.push(input.sessionId)
      return { status: 'ok', cancelled: true }
    }
  }
  return {
    api,
    calls,
    respondStart(result) {
      if (pendingStart) {
        const resolve = pendingStart
        pendingStart = undefined
        resolve(result)
      } else startQueue.push(result)
    },
    respondReview(result) {
      if (pendingReview) {
        const resolve = pendingReview
        pendingReview = undefined
        resolve(result)
      } else reviewQueue.push(result)
    }
  }
}

function installApi(stub: PracticeApiStub): PracticeApiStub {
  vi.stubGlobal('api', { vocabularyPractice: stub.api })
  return stub
}

function renderDetail(): void {
  render(
    <I18nextProvider i18n={i18n}>
      <VocabularyPracticeDetail />
    </I18nextProvider>
  )
}

function confirmCount(label = '练习单词数量'): void {
  fireEvent.submit(screen.getByLabelText(label).closest('form') as HTMLFormElement)
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  entrySerial = 0
})

describe('VocabularyPracticeDetail', () => {
  it('shows the idle hint before any round starts', () => {
    installApi(practiceApiStub())
    renderDetail()

    expect(screen.getByRole('heading', { name: '词汇练习' })).toBeInTheDocument()
    expect(screen.getByText('准备好开始了吗？')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '提交审查' })).not.toBeInTheDocument()
  })

  it('rejects invalid counts without starting a round', () => {
    const stub = installApi(practiceApiStub())
    renderDetail()

    const input = screen.getByLabelText('练习单词数量')
    for (const value of ['', '0', '-3', '51', '2.5', 'abc']) {
      fireEvent.change(input, { target: { value } })
      confirmCount()
    }
    expect(stub.calls.starts).toEqual([])
    expect(screen.getAllByText(/请输入/)).toHaveLength(1)
    expect(input).toHaveAttribute('aria-invalid', 'true')
  })

  it('starts a round, renders two-column rows and submits all answers', async () => {
    const stub = installApi(practiceApiStub())
    stub.respondStart(startOk(['apple', 'banana']))
    renderDetail()
    confirmCount()

    await waitFor(() => {
      expect(screen.getByLabelText('练习单词数量')).toBeEnabled()
    })
    expect(screen.getByText('apple')).toBeInTheDocument()
    expect(screen.getByText('banana')).toBeInTheDocument()

    // 空答案提交被拦截
    fireEvent.click(screen.getByRole('button', { name: '提交审查' }))
    expect(screen.getByText('还有未填写的释义')).toBeInTheDocument()
    expect(stub.calls.reviews).toEqual([])

    fireEvent.change(screen.getByLabelText('apple 的释义'), {
      target: { value: '一种水果' }
    })
    fireEvent.change(screen.getByLabelText('banana 的释义'), {
      target: { value: 'wrong' }
    })
    stub.respondReview({
      status: 'ok',
      verdict: 'has_errors',
      summary: 'banana 的释义有误。',
      marks: []
    })
    fireEvent.click(screen.getByRole('button', { name: '提交审查' }))

    await waitFor(() => {
      expect(screen.getByText('banana 的释义有误。')).toBeInTheDocument()
    })
    expect(stub.calls.reviews).toHaveLength(1)
    expect(stub.calls.reviews[0].sessionId).toBe('20000000-0000-4000-8000-000000000001')
    expect(stub.calls.reviews[0].answers).toEqual([
      { entryId: expect.any(String), meaning: '一种水果' },
      { entryId: expect.any(String), meaning: 'wrong' }
    ])
  })

  it('marks the wrong meaning in red with an icon and reason', async () => {
    const stub = installApi(practiceApiStub(startOk(['apple', 'banana'])))
    renderDetail()
    confirmCount()
    await waitFor(() => screen.getByText('banana'))

    const answers = screen.getAllByRole('textbox') as HTMLTextAreaElement[]
    fireEvent.change(answers[0], { target: { value: '一种水果' } })
    fireEvent.change(answers[1], { target: { value: 'wrong' } })
    expect(answers[1].id).toContain('practice-meaning-')
    stub.respondReview({
      status: 'ok',
      verdict: 'has_errors',
      summary: 'banana 的释义有误。',
      marks: [
        {
          entryId: answers[1].id.replace('practice-meaning-', ''),
          field: 'meaning',
          reason: '释义与单词含义不匹配'
        }
      ]
    })
    fireEvent.click(screen.getByRole('button', { name: '提交审查' }))

    await waitFor(() => {
      expect(screen.getByText('存在错误，已在下方标出。')).toBeInTheDocument()
    })
    const reason = screen.getByRole('alert')
    expect(within(reason).getByText('释义与单词含义不匹配')).toBeInTheDocument()
    expect(within(reason).getByText('错误', { exact: false })).toBeInTheDocument()
    expect(answers[1]).not.toHaveAttribute('readonly')
    expect(answers[1]).toHaveClass('vocabulary-practice-input-marked')
    expect(answers[1]).toHaveAttribute('aria-invalid', 'true')
    expect(answers[0]).not.toHaveClass('vocabulary-practice-input-marked')
  })

  it('shows the all-correct verdict without marks and lets edits restart review', async () => {
    const stub = installApi(practiceApiStub(startOk(['apple'])))
    renderDetail()
    confirmCount()
    await waitFor(() => screen.getByText('apple'))

    const input = screen.getAllByRole('textbox')[0] as HTMLTextAreaElement
    fireEvent.change(input, { target: { value: '一种水果' } })
    stub.respondReview({
      status: 'ok',
      verdict: 'all_correct',
      summary: '全部正确。',
      marks: []
    })
    fireEvent.click(screen.getByRole('button', { name: '提交审查' }))
    await waitFor(() => screen.getByText('全部正确！'))
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()

    expect(input).not.toHaveAttribute('readonly')

    // 修改答案清除上一轮结果，重新可提交
    fireEvent.change(input, { target: { value: '另一种水果' } })
    expect(screen.queryByText('全部正确！')).not.toBeInTheDocument()
    stub.respondReview({
      status: 'ok',
      verdict: 'all_correct',
      summary: '再次全部正确。',
      marks: []
    })
    fireEvent.click(screen.getByRole('button', { name: '提交审查' }))
    await waitFor(() => screen.getByText('再次全部正确。'))
    expect(stub.calls.reviews).toHaveLength(2)
    expect(stub.calls.reviews[1].answers[0].meaning).toBe('另一种水果')
  })

  it('keeps answers and allows retry after a failed review', async () => {
    const stub = installApi(practiceApiStub(startOk(['apple'])))
    renderDetail()
    confirmCount()
    await waitFor(() => screen.getByText('apple'))

    const input = screen.getAllByRole('textbox')[0] as HTMLTextAreaElement
    fireEvent.change(input, { target: { value: '一种水果' } })
    stub.respondReview({ status: 'error', error: { code: 'MODEL_ERROR' } })
    fireEvent.click(screen.getByRole('button', { name: '提交审查' }))
    await waitFor(() => screen.getByText('审查失败'))
    expect(screen.getByText('模型请求失败，请稍后重试。')).toBeInTheDocument()
    expect(input.value).toBe('一种水果')
    expect(input).not.toHaveAttribute('readonly')

    stub.respondReview({
      status: 'ok',
      verdict: 'all_correct',
      summary: '全部正确。',
      marks: []
    })
    fireEvent.click(screen.getByRole('button', { name: '提交审查' }))
    await waitFor(() => screen.getByText('全部正确！'))
  })

  it('returns to answering with a notice after cancelling a review', async () => {
    const stub = installApi(practiceApiStub(startOk(['apple'])))
    renderDetail()
    confirmCount()
    await waitFor(() => screen.getByText('apple'))

    const input = screen.getAllByRole('textbox')[0] as HTMLTextAreaElement
    fireEvent.change(input, { target: { value: '一种水果' } })
    fireEvent.click(screen.getByRole('button', { name: '提交审查' }))
    expect(await screen.findByText('正在审查答案…')).toBeInTheDocument()
    expect(input).toHaveAttribute('readonly')

    fireEvent.click(screen.getByRole('button', { name: '取消审查' }))
    stub.respondReview({ status: 'error', error: { code: 'CANCELLED' } })
    await waitFor(() => screen.getByText('审查已取消，答案已保留，可修改后重新提交。'))
    expect(input).not.toHaveAttribute('readonly')
    expect(input.value).toBe('一种水果')
    expect(stub.calls.cancels).toEqual(['20000000-0000-4000-8000-000000000001'])
  })

  it('asks for confirmation before starting a new round with unsubmitted answers', async () => {
    const stub = installApi(practiceApiStub(startOk(['apple'])))
    renderDetail()
    confirmCount()
    await waitFor(() => screen.getByText('apple'))
    fireEvent.change(screen.getAllByRole('textbox')[0], { target: { value: '部分答案' } })

    confirmCount()
    const dialog = screen.getByRole('dialog', { name: '开始新一轮练习' })
    expect(within(dialog).getByText(/当前答案尚未提交审查/)).toBeInTheDocument()
    expect(stub.calls.starts).toEqual([10])

    // 取消：保留当前轮次
    fireEvent.click(within(dialog).getByRole('button', { name: '继续作答' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(screen.getByText('apple')).toBeInTheDocument()

    // 确认：开启新一轮并清空旧答案
    stub.respondStart(startOk(['cherry']))
    confirmCount()
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '开始新一轮' }))
    await waitFor(() => screen.getByText('cherry'))
    expect(screen.queryByText('apple')).not.toBeInTheDocument()
    expect((screen.getAllByRole('textbox')[0] as HTMLTextAreaElement).value).toBe('')
    expect(stub.calls.starts).toEqual([10, 10])
  })

  it('reports fewer words than requested and an empty vocabulary', async () => {
    const stub = installApi(practiceApiStub())
    stub.respondStart({
      status: 'ok',
      sessionId: '20000000-0000-4000-8000-000000000002',
      requestedCount: 5,
      actualCount: 2,
      entries: [
        { entryId: entryId(), term: 'apple' },
        { entryId: entryId(), term: 'banana' }
      ]
    })
    renderDetail()
    confirmCount()
    expect(await screen.findByText('词库中只有 2 个词，已全部加入本轮练习。')).toBeInTheDocument()

    stub.respondStart({
      status: 'ok',
      sessionId: '20000000-0000-4000-8000-000000000003',
      requestedCount: 5,
      actualCount: 0,
      entries: []
    })
    confirmCount()
    expect(await screen.findByText('还没有可练习的词汇')).toBeInTheDocument()
  })

  it('renders accessible names in English', async () => {
    await i18n.changeLanguage('en')
    const stub = installApi(practiceApiStub(startOk(['apple'])))
    try {
      renderDetail()
      expect(screen.getByRole('heading', { name: 'Vocabulary practice' })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Confirm' })).toBeInTheDocument()
      expect(screen.getByText('Ready to practice?')).toBeInTheDocument()

      confirmCount('Number of words')
      await waitFor(() => screen.getByText('apple'))
      expect(screen.getByRole('button', { name: 'Submit for review' })).toBeInTheDocument()
    } finally {
      void i18n.changeLanguage('zh-CN')
    }
    expect(stub.calls.starts).toEqual([10])
  })
})
