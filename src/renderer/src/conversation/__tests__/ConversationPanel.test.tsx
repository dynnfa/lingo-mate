// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { I18nextProvider } from 'react-i18next'
import type { ReactElement } from 'react'
import { createI18n } from '../../i18n'
import { ConversationPanel } from '../ConversationPanel'
import type { ConversationStatus, DisplayMessage } from '../conversation-state'

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
        onRunSkill={props.onRunSkill ?? (() => {})}
        onCancel={props.onCancel ?? (() => {})}
        onRetry={props.onRetry ?? (() => {})}
      />
    </I18nextProvider>
  )
}

interface PanelCallbacks {
  onSend: Mock<(text: string) => void>
  onRunSkill: Mock<(input: { skillId: 'vocabulary' | 'phrase' | 'synonym'; text: string }) => void>
  onCancel: Mock<() => void>
  onRetry: Mock<(messageId: string) => void>
}

function renderPanel(props: Partial<Parameters<typeof ConversationPanel>[0]> = {}): {
  view: ReturnType<typeof render>
  callbacks: PanelCallbacks
} {
  const callbacks: PanelCallbacks = {
    onSend: vi.fn<(text: string) => void>(),
    onRunSkill:
      vi.fn<(input: { skillId: 'vocabulary' | 'phrase' | 'synonym'; text: string }) => void>(),
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

// ---------- `/` 行动选择器 ----------

// jsdom 中用户输入不会自动带焦点，聚焦后模拟真实键鼠路径。
function focusComposer(): HTMLTextAreaElement {
  const input = screen.getByLabelText('练习内容')
  if (!(input instanceof HTMLTextAreaElement)) throw new Error('Composer textarea not found')
  fireEvent.focus(input)
  return input
}

function typeDraft(value: string): HTMLTextAreaElement {
  const input = focusComposer()
  fireEvent.change(input, { target: { value } })
  return input
}

function pickerOptions(): HTMLElement[] {
  return screen.getAllByRole('option')
}

describe('ConversationPanel slash trigger and filtering', () => {
  it('opens the picker above the composer when the draft starts with a half-width slash', () => {
    renderPanel()
    const input = typeDraft('/')

    expect(input).toHaveAttribute('aria-expanded', 'true')
    expect(input).toHaveAttribute('role', 'combobox')
    expect(input).toHaveAttribute('aria-autocomplete', 'list')
    expect(input).toHaveAttribute('aria-controls', 'conversation-action-picker')
    expect(document.getElementById('conversation-action-picker')).toBeInTheDocument()

    const listbox = screen.getByRole('listbox', { name: '可用行动' })
    expect(listbox).toBeInTheDocument()
    expect(pickerOptions()).toHaveLength(7)
    // 首次打开默认高亮第一项
    expect(input).toHaveAttribute('aria-activedescendant', 'conversation-action-option-translate')
  })

  it('does not open for non-leading slash, leading space or full-width slash', () => {
    renderPanel()
    for (const value of ['hello /', ' /', '／', '／tr', 'practice /now']) {
      const input = typeDraft(value)
      expect(screen.queryByRole('listbox'), `draft: ${value}`).not.toBeInTheDocument()
      expect(input).toHaveAttribute('aria-expanded', 'false')
    }
  })

  it('filters by command name and localized name case-insensitively', () => {
    renderPanel()
    typeDraft('/润')
    expect(pickerOptions()).toHaveLength(1)
    expect(pickerOptions()[0]).toHaveTextContent('润色')

    typeDraft('/TRA')
    expect(pickerOptions()).toHaveLength(1)
    expect(pickerOptions()[0]).toHaveTextContent('翻译')

    typeDraft('/t')
    expect(pickerOptions()).toHaveLength(3)
    // 过滤后高亮重置为第一项
    expect(screen.getByLabelText('练习内容')).toHaveAttribute(
      'aria-activedescendant',
      'conversation-action-option-translate'
    )
  })

  it('keeps the picker open with an empty state when nothing matches', () => {
    renderPanel()
    const input = typeDraft('/zzz')

    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
    expect(screen.getByText('没有匹配的行动')).toBeInTheDocument()
    expect(input).toHaveAttribute('aria-expanded', 'true')
    expect(input).not.toHaveAttribute('aria-activedescendant')
  })

  it('does not open while the input is not focused', () => {
    renderPanel()
    const input = screen.getByLabelText('练习内容')
    fireEvent.change(input, { target: { value: '/' } })

    expect(input).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()

    // 重新聚焦且草稿符合条件时可以重开
    fireEvent.focus(input)
    expect(input).toHaveAttribute('aria-expanded', 'true')
  })
})

describe('ConversationPanel picker keyboard selection', () => {
  it.each(['/concept pursue', '/concept　bank', ' /concept pursue '])(
    'allows a pasted complete command to submit: %s',
    (draft) => {
      const { callbacks } = renderPanel()
      const input = typeDraft(draft)
      expect(input).toHaveAttribute('aria-expanded', 'false')
      expect(screen.getByRole('button', { name: '发送' })).toBeEnabled()
      // 多行输入域的 Enter 由组件显式拦截并提交；默认表单提交不再发生。
      expect(fireEvent.keyDown(input, { key: 'Enter' })).toBe(false)
      expect(callbacks.onSend).toHaveBeenCalledExactlyOnceWith(draft)
      expect(callbacks.onRunSkill).not.toHaveBeenCalled()
      // 提交后草稿已清空：重复的表单提交不会再发送。
      fireEvent.submit(input.closest('form') as HTMLFormElement)
      expect(callbacks.onSend).toHaveBeenCalledTimes(1)
    }
  )

  it('treats Shift+Enter as a newline instead of submitting', () => {
    const { callbacks } = renderPanel()
    const input = typeDraft('line one')

    expect(fireEvent.keyDown(input, { key: 'Enter', shiftKey: true })).toBe(true)
    expect(fireEvent.keyDown(input, { key: 'Enter', ctrlKey: true })).toBe(true)
    expect(callbacks.onSend).not.toHaveBeenCalled()
    expect(input).toHaveValue('line one')
  })

  it('closes the picker when typing concept arguments and reopens after deleting them', () => {
    const { callbacks } = renderPanel()
    const input = typeDraft('/concept')
    expect(input).toHaveAttribute('aria-expanded', 'true')
    fireEvent.change(input, { target: { value: '/concept ' } })
    expect(input).toHaveAttribute('aria-expanded', 'false')
    fireEvent.change(input, { target: { value: '/concept pursue' } })
    expect(screen.getByRole('button', { name: '发送' })).toBeEnabled()
    fireEvent.change(input, { target: { value: '/concept' } })
    expect(input).toHaveAttribute('aria-expanded', 'true')
    fireEvent.change(input, { target: { value: '/concept pursue' } })
    fireEvent.click(screen.getByRole('button', { name: '发送' }))
    expect(callbacks.onSend).toHaveBeenCalledExactlyOnceWith('/concept pursue')
  })

  it('moves the highlight with Arrow keys and wraps at both ends', () => {
    renderPanel()
    const input = typeDraft('/')

    fireEvent.keyDown(input, { key: 'ArrowDown' })
    expect(input).toHaveAttribute('aria-activedescendant', 'conversation-action-option-polish')
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    expect(input).toHaveAttribute('aria-activedescendant', 'conversation-action-option-practice')
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    expect(input).toHaveAttribute('aria-activedescendant', 'conversation-action-option-concept')
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    expect(input).toHaveAttribute('aria-activedescendant', 'conversation-action-option-vocabulary')
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    expect(input).toHaveAttribute('aria-activedescendant', 'conversation-action-option-phrase')
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    expect(input).toHaveAttribute('aria-activedescendant', 'conversation-action-option-synonym')
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    expect(input).toHaveAttribute('aria-activedescendant', 'conversation-action-option-translate')
    fireEvent.keyDown(input, { key: 'ArrowUp' })
    expect(input).toHaveAttribute('aria-activedescendant', 'conversation-action-option-synonym')
  })

  it('selects the highlighted action with Enter without sending and keeps focus in the input', () => {
    const { callbacks } = renderPanel()
    const input = typeDraft('/')

    fireEvent.keyDown(input, { key: 'ArrowDown' })
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(callbacks.onSend).not.toHaveBeenCalled()
    expect(input).toHaveValue('/polish ')
    expect(input).toHaveFocus()
    expect(input).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
  })

  it.each([
    ['partial command', '/voc', 'vocabulary', '/vocabulary '],
    ['full command', '/translate', 'translate', '/translate '],
    ['slash only', '/', 'translate', '/translate '],
    ['localized name', '/润', 'polish', '/polish ']
  ])(
    'selects the same candidate with Enter and Tab: %s',
    (_scenario, draft, expectedId, expectedValue) => {
      for (const key of ['Enter', 'Tab'] as const) {
        cleanup()
        const { callbacks } = renderPanel()
        const input = typeDraft(draft)

        expect(input).toHaveAttribute(
          'aria-activedescendant',
          `conversation-action-option-${expectedId}`
        )
        // 选择成功时阻止默认行为：Enter 不提交表单，Tab 不移动焦点
        expect(fireEvent.keyDown(input, { key })).toBe(false)

        expect(input).toHaveValue(expectedValue)
        expect(input).toHaveFocus()
        expect(input).toHaveAttribute('aria-expanded', 'false')
        expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
        expect(callbacks.onSend).not.toHaveBeenCalled()
        expect(callbacks.onRunSkill).not.toHaveBeenCalled()
      }
    }
  )

  it('selects the arrow-key-highlighted action with Tab without sending', () => {
    const { callbacks } = renderPanel()
    const input = typeDraft('/')

    fireEvent.keyDown(input, { key: 'ArrowDown' })
    expect(fireEvent.keyDown(input, { key: 'Tab' })).toBe(false)

    expect(callbacks.onSend).not.toHaveBeenCalled()
    expect(callbacks.onRunSkill).not.toHaveBeenCalled()
    expect(input).toHaveValue('/polish ')
    expect(input).toHaveFocus()
    expect(input).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
  })

  it('selects the hover-highlighted action with Tab', () => {
    const { callbacks } = renderPanel()
    const input = typeDraft('/')

    fireEvent.mouseEnter(screen.getByRole('option', { name: /口语练习/ }))
    fireEvent.keyDown(input, { key: 'Tab' })

    expect(input).toHaveValue('/practice ')
    expect(callbacks.onSend).not.toHaveBeenCalled()
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
  })

  it('keeps concept in the conversation composer and submits the draft as a normal message', () => {
    const { callbacks } = renderPanel()
    const input = typeDraft('/concept')

    expect(pickerOptions()).toHaveLength(1)
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(input).toHaveValue('/concept ')
    expect(callbacks.onSend).not.toHaveBeenCalled()
    expect(callbacks.onRunSkill).not.toHaveBeenCalled()

    fireEvent.change(input, { target: { value: '/concept pursue' } })
    fireEvent.submit(input.closest('form') as HTMLFormElement)

    // 命令原文按普通消息提交，由 Core 识别并应用概念讲解提示词
    expect(callbacks.onSend).toHaveBeenCalledExactlyOnceWith('/concept pursue')
    expect(callbacks.onRunSkill).not.toHaveBeenCalled()
    expect(input).toHaveValue('')
  })

  it('keeps vocabulary in the conversation composer and submits typed arguments as a skill', () => {
    const { callbacks } = renderPanel()
    const input = typeDraft('/vocabulary')

    fireEvent.keyDown(input, { key: 'Enter' })
    expect(input).toHaveValue('/vocabulary ')
    expect(screen.getByRole('region', { name: '对话记录' })).toBeInTheDocument()
    expect(callbacks.onSend).not.toHaveBeenCalled()

    fireEvent.change(input, { target: { value: '/vocabulary apple, banana' } })
    fireEvent.submit(input.closest('form') as HTMLFormElement)

    expect(callbacks.onRunSkill).toHaveBeenCalledExactlyOnceWith({
      skillId: 'vocabulary',
      text: 'apple, banana'
    })
    expect(callbacks.onSend).not.toHaveBeenCalled()
    expect(input).toHaveValue('')
  })

  it('keeps a Tab-selected vocabulary in the composer and submits the same arguments as Enter', () => {
    const { callbacks } = renderPanel()
    const input = typeDraft('/voc')

    fireEvent.keyDown(input, { key: 'Tab' })
    expect(input).toHaveValue('/vocabulary ')
    expect(callbacks.onSend).not.toHaveBeenCalled()
    expect(callbacks.onRunSkill).not.toHaveBeenCalled()

    fireEvent.change(input, { target: { value: '/vocabulary apple, banana' } })
    fireEvent.submit(input.closest('form') as HTMLFormElement)

    expect(callbacks.onRunSkill).toHaveBeenCalledExactlyOnceWith({
      skillId: 'vocabulary',
      text: 'apple, banana'
    })
    expect(callbacks.onSend).not.toHaveBeenCalled()
    expect(input).toHaveValue('')
  })

  it('submits typed and picker-selected synonym commands using the business API', () => {
    const { callbacks } = renderPanel()
    const input = typeDraft('/synonym adequate, decent')
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
    expect(screen.getByPlaceholderText(/例如：\/synonym/)).toBeInTheDocument()
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(callbacks.onRunSkill).toHaveBeenLastCalledWith({
      skillId: 'synonym',
      text: 'adequate, decent'
    })
    fireEvent.change(input, { target: { value: '/synonym' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(input).toHaveValue('/synonym ')
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(screen.getByRole('alert')).toHaveTextContent('请在 /synonym 后输入')
    fireEvent.change(input, { target: { value: '/synonym good，nice' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(callbacks.onRunSkill).toHaveBeenLastCalledWith({
      skillId: 'synonym',
      text: 'good，nice'
    })
    expect(callbacks.onSend).not.toHaveBeenCalled()
  })

  it('submits a directly typed /phrase command as a skill without the picker', () => {
    const { callbacks } = renderPanel()
    const input = typeDraft('/phrase look forward to')

    // 完整 /phrase 命令进入参数阶段：弹层关闭，Enter 直接提交为技能请求。
    expect(input).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
    expect(fireEvent.keyDown(input, { key: 'Enter' })).toBe(false)

    expect(callbacks.onRunSkill).toHaveBeenCalledExactlyOnceWith({
      skillId: 'phrase',
      text: 'look forward to'
    })
    expect(callbacks.onSend).not.toHaveBeenCalled()
    expect(input).toHaveValue('')
  })

  it('selects phrase from the picker and submits multiline arguments as a skill', () => {
    const { callbacks } = renderPanel()
    const input = typeDraft('/phr')

    expect(pickerOptions()).toHaveLength(1)
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(input).toHaveValue('/phrase ')
    expect(callbacks.onSend).not.toHaveBeenCalled()
    expect(callbacks.onRunSkill).not.toHaveBeenCalled()

    // 多行短语参数：Shift+Enter 换行不提交，行结构与行内空格原样传递。
    fireEvent.change(input, { target: { value: '/phrase look forward to\n' } })
    expect(fireEvent.keyDown(input, { key: 'Enter', shiftKey: true })).toBe(true)
    fireEvent.change(input, {
      target: { value: '/phrase look forward to\nif anything, at all' }
    })
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(callbacks.onRunSkill).toHaveBeenCalledExactlyOnceWith({
      skillId: 'phrase',
      text: 'look forward to\nif anything, at all'
    })
    expect(callbacks.onSend).not.toHaveBeenCalled()
    expect(input).toHaveValue('')
  })

  it('requires phrase arguments before submitting', () => {
    const { callbacks } = renderPanel()
    const input = typeDraft('/phrase')

    fireEvent.keyDown(input, { key: 'Enter' })
    expect(input).toHaveValue('/phrase ')
    fireEvent.submit(input.closest('form') as HTMLFormElement)

    expect(screen.getByRole('alert')).toHaveTextContent('请在 /phrase 后输入')
    expect(callbacks.onRunSkill).not.toHaveBeenCalled()
    expect(input).toHaveValue('/phrase ')
  })

  it('requires vocabulary arguments and clears selection when the command is edited', () => {
    const { callbacks } = renderPanel()
    const input = typeDraft('/vocabulary')
    fireEvent.keyDown(input, { key: 'Enter' })
    fireEvent.submit(input.closest('form') as HTMLFormElement)
    expect(screen.getByRole('alert')).toHaveTextContent('请在 /vocabulary 后输入')
    expect(callbacks.onRunSkill).not.toHaveBeenCalled()

    fireEvent.change(input, { target: { value: '/vocab apple' } })
    fireEvent.keyDown(input, { key: 'Escape' })
    fireEvent.submit(input.closest('form') as HTMLFormElement)
    expect(callbacks.onSend).toHaveBeenCalledWith('/vocab apple')
  })

  it('does not select or send on Enter when nothing matches', () => {
    const { callbacks } = renderPanel()
    const input = typeDraft('/zzz')

    fireEvent.keyDown(input, { key: 'Enter' })
    fireEvent.submit(input.closest('form') as HTMLFormElement)

    expect(callbacks.onSend).not.toHaveBeenCalled()
    expect(input).toHaveValue('/zzz')
    expect(input).toHaveAttribute('aria-expanded', 'true')
  })

  it('selects with a mouse click through the same entry as the keyboard', () => {
    const { callbacks } = renderPanel()
    const input = typeDraft('/')

    const option = screen.getByRole('option', { name: /口语练习/ })
    fireEvent.mouseDown(option)
    fireEvent.click(option)

    expect(callbacks.onSend).not.toHaveBeenCalled()
    expect(input).toHaveValue('/practice ')
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
  })

  it('highlights the hovered option', () => {
    renderPanel()
    const input = typeDraft('/')

    fireEvent.mouseEnter(screen.getByRole('option', { name: /润色/ }))

    expect(input).toHaveAttribute('aria-activedescendant', 'conversation-action-option-polish')
  })
})

describe('ConversationPanel picker closing and reopen suppression', () => {
  it('closes on Escape, keeps the draft, and allows sending the literal slash text', () => {
    const { callbacks } = renderPanel()
    const input = typeDraft('/tr')

    fireEvent.keyDown(input, { key: 'Escape' })

    expect(input).toHaveAttribute('aria-expanded', 'false')
    expect(input).not.toHaveAttribute('aria-activedescendant')
    expect(input).toHaveValue('/tr')
    expect(screen.getByRole('button', { name: '发送' })).toBeEnabled()

    fireEvent.click(screen.getByRole('button', { name: '发送' }))
    expect(callbacks.onSend).toHaveBeenCalledTimes(1)
    expect(callbacks.onSend).toHaveBeenCalledWith('/tr')
  })

  it('does not reopen on plain rerenders after Escape but reopens on the next edit or refocus', () => {
    const { view } = renderPanel()
    const input = typeDraft('/tr')
    fireEvent.keyDown(input, { key: 'Escape' })

    // 同一草稿的普通重渲染不重开
    view.rerender(panelElement({ messages: [message({ messageId: 'm-1' })] }))
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()

    // 下一次符合条件的人工编辑可以重开
    fireEvent.change(input, { target: { value: '/tra' } })
    expect(screen.getByRole('listbox')).toBeInTheDocument()

    // Escape 后失焦再聚焦同样可以重开
    fireEvent.keyDown(input, { key: 'Escape' })
    fireEvent.blur(input)
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
    fireEvent.focus(input)
    expect(screen.getByRole('listbox')).toBeInTheDocument()
  })

  it('closes on blur and reopens on refocus when the close was implicit', () => {
    renderPanel()
    const input = typeDraft('/')

    fireEvent.blur(input)
    expect(input).toHaveAttribute('aria-expanded', 'false')

    fireEvent.focus(input)
    expect(input).toHaveAttribute('aria-expanded', 'true')
  })

  it('closes on Tab without selecting when nothing matches and keeps the draft', () => {
    const { callbacks } = renderPanel()
    const input = typeDraft('/zzz')

    // 无匹配项时不选择，也不阻止默认焦点跳转
    expect(fireEvent.keyDown(input, { key: 'Tab' })).toBe(true)

    expect(callbacks.onSend).not.toHaveBeenCalled()
    expect(input).toHaveValue('/zzz')
    expect(input).toHaveAttribute('aria-expanded', 'false')
  })

  it('closes on Shift+Tab without selecting and keeps reverse focus navigation', () => {
    const { callbacks } = renderPanel()
    const input = typeDraft('/')

    expect(fireEvent.keyDown(input, { key: 'Tab', shiftKey: true })).toBe(true)

    expect(callbacks.onSend).not.toHaveBeenCalled()
    expect(callbacks.onRunSkill).not.toHaveBeenCalled()
    expect(input).toHaveValue('/')
    expect(input).toHaveAttribute('aria-expanded', 'false')
  })

  it('passes Ctrl, Alt and Meta Tab combinations through without selecting or blocking', () => {
    const { callbacks } = renderPanel()
    const input = typeDraft('/voc')

    for (const modifiers of [{ ctrlKey: true }, { altKey: true }, { metaKey: true }]) {
      expect(fireEvent.keyDown(input, { key: 'Tab', ...modifiers })).toBe(true)
    }

    expect(callbacks.onSend).not.toHaveBeenCalled()
    expect(callbacks.onRunSkill).not.toHaveBeenCalled()
    expect(input).toHaveValue('/voc')
    // 组合键不视为候选交互，列表保持打开
    expect(input).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByRole('listbox')).toBeInTheDocument()
  })

  it('leaves Tab to default focus navigation for plain text without the picker', () => {
    const { callbacks } = renderPanel()
    const input = typeDraft('hello')

    expect(fireEvent.keyDown(input, { key: 'Tab' })).toBe(true)

    expect(input).toHaveValue('hello')
    expect(callbacks.onSend).not.toHaveBeenCalled()
  })

  it('does not select on Tab while the composer is locked', () => {
    const { view, callbacks } = renderPanel()
    const input = typeDraft('/voc')

    view.rerender(panelElement({ composerLocked: true }))

    expect(fireEvent.keyDown(input, { key: 'Tab' })).toBe(true)
    expect(input).toHaveValue('/voc')
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
    expect(callbacks.onSend).not.toHaveBeenCalled()
  })

  it('does not reopen the suppressed draft after an action selection', () => {
    renderPanel()
    const input = typeDraft('/tra')

    fireEvent.keyDown(input, { key: 'Enter' })
    expect(input).toHaveValue('/translate ')
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()

    // 继续补充参数不弹回
    fireEvent.change(input, { target: { value: '/translate Good morning' } })
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()

    // 失焦后重新聚焦同样保持关闭
    fireEvent.blur(input)
    fireEvent.focus(input)
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()

    // 草稿失去 `/` 前缀后，新的 `/` 前缀输入可以重新触发
    fireEvent.change(input, { target: { value: 'Good morning' } })
    fireEvent.change(input, { target: { value: '/p' } })
    expect(screen.getByRole('listbox')).toBeInTheDocument()
  })

  it('does not reopen the suppressed draft after a Tab selection and lets the next Tab leave', () => {
    const { view } = renderPanel()
    const input = typeDraft('/tra')

    fireEvent.keyDown(input, { key: 'Tab' })
    expect(input).toHaveValue('/translate ')
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()

    // 同一草稿的普通重渲染不弹回
    view.rerender(panelElement({ messages: [message({ messageId: 'm-1' })] }))
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()

    // 继续补充参数、失焦后重新聚焦同样保持关闭
    fireEvent.change(input, { target: { value: '/translate Good morning' } })
    fireEvent.blur(input)
    fireEvent.focus(input)
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()

    // 列表已关闭：再次按 Tab 不再被拦截，焦点按默认顺序移出
    expect(fireEvent.keyDown(input, { key: 'Tab' })).toBe(true)

    // 草稿失去 `/` 前缀后，新的 `/` 前缀输入可以重新触发
    fireEvent.change(input, { target: { value: 'Good morning' } })
    fireEvent.change(input, { target: { value: '/p' } })
    expect(screen.getByRole('listbox')).toBeInTheDocument()
  })

  it('opens the picker for a new slash draft after sending a selected action', () => {
    const { callbacks } = renderPanel()
    const input = typeDraft('/')

    fireEvent.keyDown(input, { key: 'ArrowDown' })
    fireEvent.keyDown(input, { key: 'Enter' })
    fireEvent.change(input, { target: { value: '/polish Hello' } })
    fireEvent.submit(input.closest('form') as HTMLFormElement)

    expect(callbacks.onSend).toHaveBeenCalledExactlyOnceWith('/polish Hello')
    expect(input).toHaveValue('')
    expect(input).not.toHaveAttribute('aria-activedescendant')

    fireEvent.change(input, { target: { value: '/' } })
    expect(input).toHaveAttribute('aria-expanded', 'true')
    expect(pickerOptions()).toHaveLength(7)
    expect(input).toHaveAttribute('aria-activedescendant', 'conversation-action-option-translate')

    fireEvent.keyDown(input, { key: 'Enter' })
    expect(input).toHaveValue('/translate ')
    expect(callbacks.onSend).toHaveBeenCalledTimes(1)
  })

  it('closes and preserves the draft while the composer is locked', () => {
    const { view } = renderPanel()
    const input = typeDraft('/tr')

    view.rerender(panelElement({ composerLocked: true }))
    expect(input).toBeDisabled()
    expect(input).toHaveValue('/tr')
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()

    // 真实窗口中禁用会使输入框失焦；失焦后解除锁定不主动重开
    fireEvent.blur(input)
    view.rerender(panelElement({ composerLocked: false }))
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
    expect(input).toHaveValue('/tr')
  })
})

describe('ConversationPanel picker submit protection', () => {
  it('disables the send button and blocks form submit while the picker is open', () => {
    const { callbacks } = renderPanel()
    const input = typeDraft('/polish 你好')

    expect(screen.getByRole('button', { name: '发送' })).toBeDisabled()
    fireEvent.submit(input.closest('form') as HTMLFormElement)
    expect(callbacks.onSend).not.toHaveBeenCalled()
  })
})

describe('ConversationPanel picker input method composition', () => {
  it.each(['ordinary draft', 'dismissed picker', 'selected action'])(
    'blocks submit during composition with %s and allows it after composition ends',
    (scenario) => {
      const { callbacks } = renderPanel()
      const input = typeDraft(scenario === 'ordinary draft' ? '你好' : '/tr')
      if (scenario === 'dismissed picker') {
        fireEvent.keyDown(input, { key: 'Escape' })
      } else if (scenario === 'selected action') {
        fireEvent.keyDown(input, { key: 'Enter' })
        fireEvent.change(input, { target: { value: '/translate 你好' } })
      }
      const draft = input.value
      const form = input.closest('form') as HTMLFormElement
      expect(input).toHaveAttribute('aria-expanded', 'false')

      fireEvent.compositionStart(input)
      fireEvent.keyDown(input, { key: 'Enter', isComposing: true })
      fireEvent.submit(form)

      expect(callbacks.onSend).not.toHaveBeenCalled()
      expect(input).toHaveValue(draft)

      fireEvent.compositionEnd(input)
      fireEvent.submit(form)
      expect(callbacks.onSend).toHaveBeenCalledExactlyOnceWith(draft)
      expect(input).toHaveValue('')
    }
  )

  it('freezes candidates during composition and applies the query after it ends', () => {
    const { callbacks } = renderPanel()
    const input = typeDraft('/')

    fireEvent.compositionStart(input)
    fireEvent.change(input, { target: { value: '/翻' } })

    // 组合期间不刷新候选
    expect(pickerOptions()).toHaveLength(7)

    // 组合确认键不选择候选、不发送
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true })
    expect(callbacks.onSend).not.toHaveBeenCalled()
    expect(input).toHaveValue('/翻')

    fireEvent.compositionEnd(input)
    expect(pickerOptions()).toHaveLength(1)
    expect(pickerOptions()[0]).toHaveTextContent('翻译')
    expect(input).toHaveAttribute('aria-activedescendant', 'conversation-action-option-translate')
  })

  it('does not select on Tab during input method composition', () => {
    const { callbacks } = renderPanel()
    const input = typeDraft('/')

    // React 组合状态与原生 isComposing 标记都不触发选择，也不拦截按键
    fireEvent.compositionStart(input)
    expect(fireEvent.keyDown(input, { key: 'Tab' })).toBe(true)
    fireEvent.keyDown(input, { key: 'Tab', isComposing: true })
    fireEvent.compositionEnd(input)

    expect(callbacks.onSend).not.toHaveBeenCalled()
    expect(callbacks.onRunSkill).not.toHaveBeenCalled()
    expect(input).toHaveValue('/')
    expect(input).toHaveAttribute('aria-expanded', 'true')
  })
})

describe('ConversationPanel picker language switch', () => {
  it('retranslates candidates and keeps the draft and highlight without reopening state', () => {
    const { view } = renderPanel()
    // /po 命中命令名 polish，两种界面语言下都有效
    const input = typeDraft('/po')

    expect(pickerOptions()).toHaveLength(1)

    view.rerender(
      <I18nextProvider i18n={createI18n('en')}>
        <ConversationPanel
          messages={[]}
          status={{ kind: 'ready' }}
          generating={false}
          composerLocked={false}
          onSend={() => {}}
          onCancel={() => {}}
          onRetry={() => {}}
        />
      </I18nextProvider>
    )

    const translated = screen.getByRole('listbox', { name: 'Available actions' })
    expect(translated).toBeInTheDocument()
    expect(screen.getByRole('option', { name: /Polish/ })).toHaveTextContent('/polish')
    expect(input).toHaveValue('/po')
    expect(input).toHaveAttribute('aria-activedescendant', 'conversation-action-option-polish')
  })
})
