// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { I18nextProvider } from 'react-i18next'
import { createI18n } from '../../i18n'
import { ConversationActionPicker } from '../ConversationActionPicker'
import { CONVERSATION_ACTIONS, type ConversationActionMeta } from '../conversation-actions'

// 测试语言显式固定为 zh-CN，断言使用真实资源渲染的文本与可访问名称。
const i18n = createI18n('zh-CN')

interface PickerCallbacks {
  onSelect: Mock<(action: ConversationActionMeta) => void>
  onHighlight: Mock<(actionId: string) => void>
}

function renderPicker(
  props: Partial<Parameters<typeof ConversationActionPicker>[0]> = {}
): PickerCallbacks {
  const callbacks: PickerCallbacks = {
    onSelect: vi.fn<(action: ConversationActionMeta) => void>(),
    onHighlight: vi.fn<(actionId: string) => void>()
  }
  render(
    <I18nextProvider i18n={i18n}>
      <ConversationActionPicker
        actions={props.actions ?? [...CONVERSATION_ACTIONS]}
        highlightedActionId={props.highlightedActionId ?? null}
        onHighlight={props.onHighlight ?? callbacks.onHighlight}
        onSelect={props.onSelect ?? callbacks.onSelect}
      />
    </I18nextProvider>
  )
  return callbacks
}

afterEach(() => {
  cleanup()
})

describe('ConversationActionPicker rendering', () => {
  it('renders each action with localized name, description and command', () => {
    renderPicker()

    const listbox = screen.getByRole('listbox', { name: '可用行动' })
    const options = screen.getAllByRole('option')
    expect(options).toHaveLength(6)
    expect(listbox).toContainElement(options[0])

    expect(options[0]).toHaveTextContent('翻译')
    expect(options[0]).toHaveTextContent('/translate')
    expect(options[0]).toHaveTextContent('把文本翻译成目标语言')
    expect(options[1]).toHaveTextContent('润色')
    expect(options[2]).toHaveTextContent('口语练习')
    expect(options[3]).toHaveTextContent('概念讲解')
    expect(options[3]).toHaveTextContent('/concept')
    expect(options[4]).toHaveTextContent('收藏词汇')
  })

  it('marks only the highlighted option as selected', () => {
    renderPicker({ highlightedActionId: 'polish' })

    const options = screen.getAllByRole('option')
    expect(options[0]).toHaveAttribute('aria-selected', 'false')
    expect(options[1]).toHaveAttribute('aria-selected', 'true')
    expect(options[2]).toHaveAttribute('aria-selected', 'false')
  })

  it('shows the localized empty state instead of a listbox when nothing matches', () => {
    renderPicker({ actions: [] })

    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
    expect(screen.getByText('没有匹配的行动')).toBeInTheDocument()
  })

  it('keeps stable option ids for aria-activedescendant references', () => {
    renderPicker({ highlightedActionId: 'translate' })

    expect(document.getElementById('conversation-action-option-translate')).toBeInTheDocument()
    expect(document.getElementById('conversation-action-option-polish')).toBeInTheDocument()
    expect(document.getElementById('conversation-action-picker')).toBeInTheDocument()
  })
})

describe('ConversationActionPicker interactions', () => {
  it('reports the selected action meta on click', () => {
    const { onSelect } = renderPicker()

    fireEvent.mouseDown(screen.getByRole('option', { name: /润色/ }))
    fireEvent.click(screen.getByRole('option', { name: /润色/ }))

    expect(onSelect).toHaveBeenCalledTimes(1)
    expect(onSelect).toHaveBeenCalledWith(CONVERSATION_ACTIONS[1])
  })

  it('reports hover as a highlight intent without selecting', () => {
    const { onSelect, onHighlight } = renderPicker()

    fireEvent.mouseEnter(screen.getByRole('option', { name: /口语练习/ }))

    expect(onHighlight).toHaveBeenCalledTimes(1)
    expect(onHighlight).toHaveBeenCalledWith('practice')
    expect(onSelect).not.toHaveBeenCalled()
  })
})
