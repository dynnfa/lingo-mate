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
    expect(options).toHaveLength(8)
    expect(listbox).toContainElement(options[0])

    expect(options[0]).toHaveTextContent('概念讲解')
    expect(options[0]).toHaveTextContent('/concept')
    expect(options[0]).toHaveTextContent('讲清一个单词表达的核心概念')
    expect(options[1]).toHaveTextContent('收藏词汇')
    expect(options[2]).toHaveTextContent('收录短语')
    expect(options[3]).toHaveTextContent('探索短语')
    expect(options[3]).toHaveTextContent('/explore-phrase')
    expect(options[4]).toHaveTextContent('探索词汇')
    expect(options[4]).toHaveTextContent('/explore-vocabulary')
    expect(options[5]).toHaveTextContent('近义词分组')
    expect(options[5]).toHaveTextContent('/synonym')
    expect(options[6]).toHaveTextContent('句子翻译')
    expect(options[6]).toHaveTextContent('/sentence')
    expect(options[7]).toHaveTextContent('文本转语音')
    expect(options[7]).toHaveTextContent('/tts')
  })

  it('marks only the highlighted option as selected', () => {
    renderPicker({ highlightedActionId: 'vocabulary' })

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
    renderPicker({ highlightedActionId: 'concept' })

    expect(document.getElementById('conversation-action-option-concept')).toBeInTheDocument()
    expect(document.getElementById('conversation-action-option-phrase')).toBeInTheDocument()
    expect(document.getElementById('conversation-action-picker')).toBeInTheDocument()
  })
})

describe('ConversationActionPicker interactions', () => {
  it('reports the selected action meta on click', () => {
    const { onSelect } = renderPicker()

    fireEvent.mouseDown(screen.getByRole('option', { name: /收录短语/ }))
    fireEvent.click(screen.getByRole('option', { name: /收录短语/ }))

    expect(onSelect).toHaveBeenCalledTimes(1)
    expect(onSelect).toHaveBeenCalledWith(CONVERSATION_ACTIONS[2])
  })

  it('reports hover as a highlight intent without selecting', () => {
    const { onSelect, onHighlight } = renderPicker()

    fireEvent.mouseEnter(screen.getByRole('option', { name: /近义词分组/ }))

    expect(onHighlight).toHaveBeenCalledTimes(1)
    expect(onHighlight).toHaveBeenCalledWith('synonym')
    expect(onSelect).not.toHaveBeenCalled()
  })
})
