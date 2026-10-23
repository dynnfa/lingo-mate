// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { I18nextProvider } from 'react-i18next'
import type {
  SentencePracticeApi,
  SentencePracticeHintsResult,
  SentencePracticeReviewResult,
  SentencePracticeStartResult
} from '../../../../../shared/sentence-practice'
import { createI18n } from '../../../i18n'
import { SentencePracticeDetail } from '../SentencePracticeDetail'

// 组件测试固定 zh-CN 渲染；断言基于真实资源文本与可访问名称。
const i18n = createI18n('zh-CN')

const SESSION_ID = '20000000-0000-4000-8000-000000000001'
const ENTRY_IDS = [
  '10000000-0000-4000-8000-000000000001',
  '10000000-0000-4000-8000-000000000002',
  '10000000-0000-4000-8000-000000000003'
]

function startOk(terms: string[]): SentencePracticeStartResult {
  return {
    status: 'ok',
    sessionId: SESSION_ID,
    actualCount: terms.length,
    entries: terms.map((term, index) => ({ entryId: ENTRY_IDS[index], term }))
  }
}

function hintsOk(terms: string[]): SentencePracticeHintsResult {
  return {
    status: 'ok',
    hints: terms.map((term, index) => ({
      entryIds: [ENTRY_IDS[index]],
      phrase: `${term} phrase`,
      explanation: `关于 ${term} 的搭配`
    }))
  }
}

function reviewOk(options: {
  used?: boolean[]
  natural?: boolean
  grammarCorrect?: boolean
  revisedAnswer?: string | null
}): SentencePracticeReviewResult {
  const used = options.used ?? [true, true, true]
  return {
    status: 'ok',
    review: {
      wordUsage: ENTRY_IDS.map((entryId, index) => ({
        entryId,
        used: used[index] ?? true,
        correct: used[index] ?? true,
        feedback: `第 ${index + 1} 个词的反馈。`
      })),
      fluency: { natural: options.natural ?? true, feedback: '整体表达流畅。' },
      grammar: {
        correct: options.grammarCorrect ?? true,
        issues:
          (options.grammarCorrect ?? true)
            ? []
            : [{ original: 'a apple', suggestion: 'an apple', explanation: '冠词使用不当。' }]
      },
      summary: '整体不错，注意个别用法。',
      revisedAnswer: options.revisedAnswer ?? null
    }
  }
}

interface PracticeApiStub {
  api: SentencePracticeApi
  calls: {
    starts: number
    hints: string[]
    reviews: Array<{ sessionId: string; answer: string }>
    cancels: Array<{ sessionId: string; requestId: string }>
    closes: string[]
  }
  respondStart(result: SentencePracticeStartResult): void
  respondHints(result: SentencePracticeHintsResult): void
  respondReview(result: SentencePracticeReviewResult): void
}

// 结果按到达顺序消费；没有排队结果时挂起并记录 resolver，
// 让用例可以在请求发出之后再决定响应（例如取消后补 CANCELLED）。
// hints 的迟到响应按 FIFO 解析最旧的挂起请求。
function practiceApiStub(): PracticeApiStub {
  const calls = {
    starts: 0,
    hints: [] as string[],
    reviews: [] as PracticeApiStub['calls']['reviews'],
    cancels: [] as PracticeApiStub['calls']['cancels'],
    closes: [] as string[]
  }
  const startQueue: Array<SentencePracticeStartResult> = []
  const hintsQueue: Array<SentencePracticeHintsResult> = []
  const reviewQueue: Array<SentencePracticeReviewResult> = []
  let pendingStart: ((result: SentencePracticeStartResult) => void) | undefined
  const pendingHints: Array<(result: SentencePracticeHintsResult) => void> = []
  let pendingReview: ((result: SentencePracticeReviewResult) => void) | undefined
  const api: SentencePracticeApi = {
    async start() {
      calls.starts += 1
      const queued = startQueue.shift()
      if (queued) return queued
      return new Promise((resolve) => {
        pendingStart = resolve
      })
    },
    async hints(input) {
      calls.hints.push(input.sessionId)
      const queued = hintsQueue.shift()
      if (queued) return queued
      return new Promise((resolve) => {
        pendingHints.push(resolve)
      })
    },
    async review(input) {
      calls.reviews.push({ sessionId: input.sessionId, answer: input.answer })
      const queued = reviewQueue.shift()
      if (queued) return queued
      return new Promise((resolve) => {
        pendingReview = resolve
      })
    },
    async cancel(input) {
      calls.cancels.push({ sessionId: input.sessionId, requestId: input.requestId })
      return { status: 'ok', cancelled: true }
    },
    async close(input) {
      calls.closes.push(input.sessionId)
      return { status: 'ok', closed: true }
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
    respondHints(result) {
      // 解析最近一次挂起的提示请求；旧请求保持挂起以模拟迟到响应。
      const resolve = pendingHints.pop()
      if (resolve) resolve(result)
      else hintsQueue.push(result)
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
  vi.stubGlobal('api', { sentencePractice: stub.api })
  return stub
}

function renderDetail(): ReturnType<typeof render> {
  return render(
    <I18nextProvider i18n={i18n}>
      <SentencePracticeDetail />
    </I18nextProvider>
  )
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('SentencePracticeDetail', () => {
  it('auto-starts a round and renders words, hints and the answer area', async () => {
    const stub = installApi(practiceApiStub())
    stub.respondStart(startOk(['apple', 'banana', 'cherry']))
    stub.respondHints(hintsOk(['apple', 'banana', 'cherry']))
    renderDetail()

    await waitFor(() => {
      expect(screen.getByText('apple')).toBeInTheDocument()
      expect(screen.getByText('banana')).toBeInTheDocument()
      expect(screen.getByText('cherry')).toBeInTheDocument()
    })
    expect(screen.getByRole('heading', { name: '造句练习' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: '需要使用的单词' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: '短语提示' })).toBeInTheDocument()
    expect(screen.getByText('apple phrase')).toBeInTheDocument()
    expect(screen.getByText('关于 banana 的搭配')).toBeInTheDocument()
    const textarea = screen.getByLabelText('你的句子')
    expect(textarea).toBeEnabled()
    expect(screen.getByRole('button', { name: '提交点评' })).toBeInTheDocument()
    expect(stub.calls.starts).toBe(1)
    expect(stub.calls.hints).toEqual([SESSION_ID])
  })

  it('shows the empty state without any model call for a short vocabulary', async () => {
    const stub = installApi(practiceApiStub())
    stub.respondStart(startOk(['apple']))
    renderDetail()

    await waitFor(() => {
      expect(screen.getByText('词库中的单词还不够')).toBeInTheDocument()
    })
    expect(screen.getByText('词库中只有 1 个单词，造句练习需要 3 个。')).toBeInTheDocument()
    expect(stub.calls.hints).toHaveLength(0)
    expect(screen.queryByRole('button', { name: '提交点评' })).not.toBeInTheDocument()
  })

  it.each([
    ['MODEL_ERROR', '模型请求失败，请稍后重试。'],
    ['AGENT_UNAVAILABLE', 'Agent 引擎暂不可用，请重试。'],
    ['AGENT_PROTOCOL_ERROR', 'Agent 引擎未能完成请求，请重试。'],
    ['AGENT_HOST_ERROR', 'Agent 引擎未能完成请求，请重试。'],
    ['AGENT_LIMIT', 'Agent 已达到执行上限，请缩短输入后重试。']
  ] as const)('keeps words and offers retry after %s', async (code, message) => {
    const stub = installApi(practiceApiStub())
    stub.respondStart(startOk(['apple', 'banana', 'cherry']))
    renderDetail()
    stub.respondHints({ status: 'error', error: { code } })

    await waitFor(() => {
      expect(screen.getByText('提示生成失败')).toBeInTheDocument()
      expect(screen.getByText(message)).toBeInTheDocument()
    })
    expect(screen.getByText('apple')).toBeInTheDocument()
    // 提示未就绪：不可提交
    expect(screen.queryByRole('button', { name: '提交点评' })).not.toBeInTheDocument()

    stub.respondHints(hintsOk(['apple', 'banana', 'cherry']))
    fireEvent.click(screen.getByRole('button', { name: '重新生成提示' }))
    await waitFor(() => {
      expect(screen.getByText('apple phrase')).toBeInTheDocument()
    })
    expect(screen.queryByText('提示生成失败')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '提交点评' })).toBeInTheDocument()
  })

  it('blocks empty submissions with a validation message', async () => {
    const stub = installApi(practiceApiStub())
    stub.respondStart(startOk(['apple', 'banana', 'cherry']))
    stub.respondHints(hintsOk(['apple', 'banana', 'cherry']))
    renderDetail()
    await waitFor(() => {
      expect(screen.getByRole('button', { name: '提交点评' })).toBeInTheDocument()
    })

    fireEvent.click(screen.getByRole('button', { name: '提交点评' }))

    expect(screen.getByText('还没有作答')).toBeInTheDocument()
    expect(stub.calls.reviews).toHaveLength(0)
  })

  it('submits the trimmed answer and renders the three review sections', async () => {
    const stub = installApi(practiceApiStub())
    stub.respondStart(startOk(['apple', 'banana', 'cherry']))
    stub.respondHints(hintsOk(['apple', 'banana', 'cherry']))
    renderDetail()
    await waitFor(() => {
      expect(screen.getByLabelText('你的句子')).toBeEnabled()
    })
    fireEvent.change(screen.getByLabelText('你的句子'), {
      target: { value: '  I ate an apple and ripe cherries.  ' }
    })
    fireEvent.click(screen.getByRole('button', { name: '提交点评' }))

    await waitFor(() => {
      expect(screen.getByText('正在点评你的句子…')).toBeInTheDocument()
    })
    stub.respondReview(
      reviewOk({
        used: [true, false, true],
        natural: false,
        grammarCorrect: false,
        revisedAnswer: 'I ate an apple, bananas and ripe cherries.'
      })
    )

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: '点评结果' })).toBeInTheDocument()
    })
    expect(stub.calls.reviews).toEqual([
      { sessionId: SESSION_ID, answer: 'I ate an apple and ripe cherries.' }
    ])
    expect(screen.getByRole('heading', { name: '单词使用情况' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: '通顺度' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: '语法' })).toBeInTheDocument()
    // banana 未使用：状态文本 + 反馈
    expect(screen.getByText('未使用')).toBeInTheDocument()
    expect(screen.getByText('第 2 个词的反馈。')).toBeInTheDocument()
    expect(screen.getByText('不够自然')).toBeInTheDocument()
    expect(screen.getByText('语法有误')).toBeInTheDocument()
    expect(screen.getByText('a apple')).toBeInTheDocument()
    expect(screen.getByText('an apple')).toBeInTheDocument()
    expect(screen.getByText('冠词使用不当。')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: '总评' })).toBeInTheDocument()
    expect(screen.getByText('整体不错，注意个别用法。')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: '建议改写' })).toBeInTheDocument()
    expect(screen.getByText('I ate an apple, bananas and ripe cherries.')).toBeInTheDocument()
    // 不全部正确时没有总体通过标题
    expect(screen.queryByText('全部正确！')).not.toBeInTheDocument()
    // 修改答案清除旧点评并允许再次提交
    fireEvent.change(screen.getByLabelText('你的句子'), {
      target: { value: 'I ate an apple, bananas and ripe cherries.' }
    })
    expect(screen.queryByRole('heading', { name: '点评结果' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '提交点评' })).toBeInTheDocument()
  })

  it('shows the all-passed headline only when everything is correct', async () => {
    const stub = installApi(practiceApiStub())
    stub.respondStart(startOk(['apple', 'banana', 'cherry']))
    stub.respondHints(hintsOk(['apple', 'banana', 'cherry']))
    renderDetail()
    await waitFor(() => {
      expect(screen.getByLabelText('你的句子')).toBeEnabled()
    })
    fireEvent.change(screen.getByLabelText('你的句子'), {
      target: { value: 'I ate an apple, a bunch of bananas and ripe cherries.' }
    })
    fireEvent.click(screen.getByRole('button', { name: '提交点评' }))
    stub.respondReview(reviewOk({}))

    await waitFor(() => {
      expect(screen.getByText('全部正确！')).toBeInTheDocument()
    })
    expect(screen.getAllByText('使用正确')).toHaveLength(3)
    expect(screen.getByText('通顺自然')).toBeInTheDocument()
    expect(screen.getByText('语法正确')).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: '建议改写' })).not.toBeInTheDocument()
  })

  it('keeps the answer and shows a notice after cancellation', async () => {
    const stub = installApi(practiceApiStub())
    stub.respondStart(startOk(['apple', 'banana', 'cherry']))
    stub.respondHints(hintsOk(['apple', 'banana', 'cherry']))
    renderDetail()
    await waitFor(() => {
      expect(screen.getByLabelText('你的句子')).toBeEnabled()
    })
    fireEvent.change(screen.getByLabelText('你的句子'), {
      target: { value: 'I ate an apple.' }
    })
    fireEvent.click(screen.getByRole('button', { name: '提交点评' }))
    stub.respondReview({ status: 'error', error: { code: 'CANCELLED' } })

    await waitFor(() => {
      expect(screen.getByText('已取消。单词、提示和你的答案已保留。')).toBeInTheDocument()
    })
    expect(screen.getByLabelText('你的句子')).toHaveValue('I ate an apple.')
    expect(screen.getByRole('button', { name: '提交点评' })).toBeInTheDocument()
  })

  it('cancels the in-flight review by session and request id', async () => {
    const stub = installApi(practiceApiStub())
    stub.respondStart(startOk(['apple', 'banana', 'cherry']))
    stub.respondHints(hintsOk(['apple', 'banana', 'cherry']))
    renderDetail()
    await waitFor(() => {
      expect(screen.getByLabelText('你的句子')).toBeEnabled()
    })
    fireEvent.change(screen.getByLabelText('你的句子'), {
      target: { value: 'I ate an apple.' }
    })
    fireEvent.click(screen.getByRole('button', { name: '提交点评' }))
    await waitFor(() => {
      expect(screen.getByRole('button', { name: '取消' })).toBeInTheDocument()
    })

    fireEvent.click(screen.getByRole('button', { name: '取消' }))

    expect(stub.calls.cancels).toHaveLength(1)
    expect(stub.calls.cancels[0].sessionId).toBe(SESSION_ID)
    expect(stub.calls.cancels[0].requestId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
    )
    stub.respondReview({ status: 'error', error: { code: 'CANCELLED' } })
    await waitFor(() => {
      expect(screen.getByRole('button', { name: '提交点评' })).toBeInTheDocument()
    })
  })

  it('asks for confirmation before replacing words when an answer exists', async () => {
    const stub = installApi(practiceApiStub())
    stub.respondStart(startOk(['apple', 'banana', 'cherry']))
    stub.respondHints(hintsOk(['apple', 'banana', 'cherry']))
    renderDetail()
    await waitFor(() => {
      expect(screen.getByLabelText('你的句子')).toBeEnabled()
    })
    fireEvent.change(screen.getByLabelText('你的句子'), {
      target: { value: 'I ate an apple.' }
    })

    fireEvent.click(screen.getByRole('button', { name: '换一组' }))

    const dialog = screen.getByRole('dialog', { name: '换一组单词' })
    expect(dialog).toBeInTheDocument()
    expect(stub.calls.starts).toBe(1)

    // Escape 只关闭对话框，不退出练习页
    fireEvent.keyDown(dialog, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(stub.calls.starts).toBe(1)

    fireEvent.click(screen.getByRole('button', { name: '换一组' }))
    fireEvent.click(
      within(screen.getByRole('dialog', { name: '换一组单词' })).getByRole('button', {
        name: '换一组'
      })
    )
    stub.respondStart(startOk(['dog', 'cat', 'bird']))
    stub.respondHints(hintsOk(['dog', 'cat', 'bird']))
    await waitFor(() => {
      expect(screen.getByText('dog')).toBeInTheDocument()
    })
    expect(screen.getByLabelText('你的句子')).toHaveValue('')
    expect(stub.calls.starts).toBe(2)
    expect(stub.calls.closes).toEqual([SESSION_ID])
  })

  it('ignores late hint responses from a replaced round', async () => {
    const stub = installApi(practiceApiStub())
    stub.respondStart(startOk(['apple', 'banana', 'cherry']))
    renderDetail()
    await waitFor(() => {
      expect(screen.getByText('正在生成提示…')).toBeInTheDocument()
    })

    // 没有答案：换一组直接开始新轮次
    fireEvent.click(screen.getByRole('button', { name: '换一组' }))
    stub.respondStart(startOk(['dog', 'cat', 'bird']))
    await waitFor(() => {
      expect(stub.calls.hints).toHaveLength(2)
    })
    stub.respondHints(hintsOk(['dog', 'cat', 'bird']))
    await waitFor(() => {
      expect(screen.getByText('dog phrase')).toBeInTheDocument()
    })

    // 旧轮次的迟到提示到达：不覆盖新一轮
    stub.respondHints(hintsOk(['apple', 'banana', 'cherry']))
    expect(screen.getByText('dog phrase')).toBeInTheDocument()
    expect(screen.queryByText('apple phrase')).not.toBeInTheDocument()
    expect(stub.calls.closes).toEqual([SESSION_ID])
  })

  it.each(['loading', 'empty'] as const)(
    'ignores old hints while the replacement round is %s',
    async (phase) => {
      const stub = installApi(practiceApiStub())
      stub.respondStart(startOk(['apple', 'banana', 'cherry']))
      renderDetail()
      await waitFor(() => expect(stub.calls.hints).toHaveLength(1))
      fireEvent.click(screen.getByRole('button', { name: '换一组' }))
      if (phase === 'empty') {
        await act(async () => stub.respondStart(startOk(['dog'])))
      }
      await act(async () => stub.respondHints(hintsOk(['apple', 'banana', 'cherry'])))
      expect(screen.queryByText('apple phrase')).not.toBeInTheDocument()
      expect(screen.queryByRole('button', { name: '提交点评' })).not.toBeInTheDocument()
      if (phase === 'empty') {
        expect(screen.getByText('词库中的单词还不够')).toBeInTheDocument()
      } else {
        expect(screen.getByRole('button', { name: '换一组' })).toBeDisabled()
      }
    }
  )

  it('ignores cancellation from the old round while sampling its replacement', async () => {
    const stub = installApi(practiceApiStub())
    stub.respondStart(startOk(['apple', 'banana', 'cherry']))
    renderDetail()
    await waitFor(() => expect(stub.calls.hints).toHaveLength(1))
    fireEvent.click(screen.getByRole('button', { name: '换一组' }))
    await act(async () => stub.respondHints({ status: 'error', error: { code: 'CANCELLED' } }))
    expect(screen.getByRole('button', { name: '换一组' })).toBeDisabled()
    expect(screen.queryByText('提示生成失败')).not.toBeInTheDocument()
  })

  it('closes a session whose start response arrives after unmount', async () => {
    const stub = installApi(practiceApiStub())
    const view = renderDetail()
    view.unmount()
    await act(async () => stub.respondStart(startOk(['apple', 'banana', 'cherry'])))
    expect(stub.calls.closes).toEqual([SESSION_ID])
    expect(stub.calls.hints).toHaveLength(0)
  })

  it('closes the session when unmounted', async () => {
    const stub = installApi(practiceApiStub())
    stub.respondStart(startOk(['apple', 'banana', 'cherry']))
    stub.respondHints(hintsOk(['apple', 'banana', 'cherry']))
    const view = renderDetail()
    await waitFor(() => {
      expect(screen.getByText('apple')).toBeInTheDocument()
    })

    view.unmount()

    expect(stub.calls.closes).toEqual([SESSION_ID])
  })
})
