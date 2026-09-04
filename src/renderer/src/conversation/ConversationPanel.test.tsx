// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { I18nextProvider } from 'react-i18next'
import type { ReactElement } from 'react'
import { createI18n } from '../i18n'
import { ConversationPanel } from './ConversationPanel'
import type { ConversationStatus, DisplayMessage } from './conversation-state'

// 测试语言显式固定为 zh-CN，断言使用真实资源渲染的文本与可访问名称。
const i18n = createI18n('zh-CN')

function message(overrides: Partial<DisplayMessage> = {}): DisplayMessage {
  return {
    messageId: 'message-1',
    role: 'user',
    content: 'Hello',
    streaming: false,
    retryable: false,
    ...overrides
  }
}

function panelElement(props: Partial<Parameters<typeof ConversationPanel>[0]>): ReactElement {
  return (
    <I18nextProvider i18n={i18n}>
      <ConversationPanel
        messages={props.messages ?? []}
        status={props.status ?? ({ kind: 'ready' } satisfies ConversationStatus)}
        generating={props.generating ?? false}
        composerLocked={props.composerLocked ?? false}
        onSend={props.onSend ?? (() => {})}
        onCancel={props.onCancel ?? (() => {})}
        onRetry={props.onRetry ?? (() => {})}
      />
    </I18nextProvider>
  )
}

interface PanelCallbacks {
  onSend: Mock<(text: string) => void>
  onCancel: Mock<() => void>
  onRetry: Mock<(messageId: string) => void>
}

function renderPanel(props: Partial<Parameters<typeof ConversationPanel>[0]> = {}): {
  view: ReturnType<typeof render>
  callbacks: PanelCallbacks
} {
  const callbacks: PanelCallbacks = {
    onSend: vi.fn<(text: string) => void>(),
    onCancel: vi.fn<() => void>(),
    onRetry: vi.fn<(messageId: string) => void>()
  }
  const view = render(panelElement({ ...props, ...callbacks }))
  return { view, callbacks }
}

afterEach(() => {
  cleanup()
})

describe('ConversationPanel rendering', () => {
  it('shows the empty state when there are no messages', () => {
    renderPanel()

    const region = screen.getByRole('region', { name: '对话记录' })
    expect(within(region).getByText('从一句话开始')).toBeInTheDocument()
    expect(
      within(region).getByText('练习表达、修改句子，或聊聊你感兴趣的话题。')
    ).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: '从一句话开始' })).toBeInTheDocument()
  })

  it('renders incoming messages and status without caching previous props', () => {
    const { view } = renderPanel({ status: { kind: 'ready' } })

    expect(screen.getByText('从一句话开始')).toBeInTheDocument()

    view.rerender(
      panelElement({
        messages: [
          message({ messageId: 'user-1', content: 'Hello' }),
          message({
            messageId: 'assistant-1',
            role: 'assistant',
            content: '',
            streaming: true
          })
        ],
        status: { kind: 'generating' },
        generating: true,
        composerLocked: true
      })
    )

    expect(screen.queryByText('从一句话开始')).not.toBeInTheDocument()
    expect(document.querySelector('[data-message-id="user-1"]')).toHaveTextContent('Hello')
    // 空内容占位
    expect(document.querySelector('[data-message-id="assistant-1"]')).toHaveTextContent('…')
    // 状态随 props 重新翻译
    expect(document.querySelector('.status')).toHaveTextContent('正在生成…')
    expect(screen.getByRole('button', { name: '取消' })).toBeInTheDocument()
  })
})

describe('ConversationPanel composer', () => {
  it('does not send a locked or whitespace-only draft', () => {
    const { view, callbacks } = renderPanel()

    const input = screen.getByLabelText('练习内容')
    fireEvent.change(input, { target: { value: '   ' } })
    expect(screen.getByRole('button', { name: '发送' })).toBeDisabled()
    fireEvent.submit(input.closest('form') as HTMLFormElement)
    expect(callbacks.onSend).not.toHaveBeenCalled()

    view.rerender(panelElement({ composerLocked: true }))
    expect(screen.getByLabelText('练习内容')).toBeDisabled()
    fireEvent.submit(document.querySelector('.composer') as HTMLFormElement)
    expect(callbacks.onSend).not.toHaveBeenCalled()
  })

  it('sends the raw draft once and clears the input on valid submit', () => {
    const { callbacks } = renderPanel()

    const input = screen.getByLabelText('练习内容')
    fireEvent.change(input, { target: { value: '  Hello  ' } })
    fireEvent.click(screen.getByRole('button', { name: '发送' }))

    // 传原始草稿，trim 由 Controller 完成；提交后立即清空输入
    expect(callbacks.onSend).toHaveBeenCalledTimes(1)
    expect(callbacks.onSend).toHaveBeenCalledWith('  Hello  ')
    expect(input).toHaveValue('')
  })

  it('preserves the draft when the composer becomes locked', () => {
    const { view } = renderPanel()

    fireEvent.change(screen.getByLabelText('练习内容'), { target: { value: 'kept draft' } })

    view.rerender(panelElement({ composerLocked: true }))

    expect(screen.getByLabelText('练习内容')).toHaveValue('kept draft')
    expect(screen.getByLabelText('练习内容')).toBeDisabled()
  })

  it('cancels generation with a non-submitting button while generating', () => {
    const { callbacks } = renderPanel({ generating: true, composerLocked: true })

    expect(screen.queryByRole('button', { name: '发送' })).not.toBeInTheDocument()
    const form = document.querySelector('.composer') as HTMLFormElement
    const submitSpy = vi.fn()
    form.addEventListener('submit', submitSpy)

    fireEvent.click(screen.getByRole('button', { name: '取消' }))

    expect(callbacks.onCancel).toHaveBeenCalledTimes(1)
    expect(submitSpy).not.toHaveBeenCalled()
    expect(callbacks.onSend).not.toHaveBeenCalled()
  })
})

describe('ConversationPanel retry', () => {
  it('offers retry only for retryable user messages and passes the messageId', () => {
    const { callbacks } = renderPanel({
      messages: [
        message({ messageId: 'user-1', content: 'Hello', retryable: true }),
        message({ messageId: 'assistant-1', role: 'assistant', content: 'Hi', retryable: true }),
        message({ messageId: 'user-2', content: 'not retryable' })
      ]
    })

    const retryButtons = screen.getAllByRole('button', { name: '重试' })
    expect(retryButtons).toHaveLength(1)
    expect(retryButtons[0].closest('[data-message-id]')?.getAttribute('data-message-id')).toBe(
      'user-1'
    )

    fireEvent.click(retryButtons[0])
    expect(callbacks.onRetry).toHaveBeenCalledTimes(1)
    expect(callbacks.onRetry).toHaveBeenCalledWith('user-1')
  })

  it('hides retry while the composer is locked', () => {
    renderPanel({
      composerLocked: true,
      messages: [message({ messageId: 'user-1', retryable: true })]
    })

    expect(screen.queryByRole('button', { name: '重试' })).not.toBeInTheDocument()
  })
})
