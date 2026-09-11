// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { I18nextProvider } from 'react-i18next'
import { createI18n } from '../../i18n'
import { PracticePage } from '../PracticePage'

// 组件测试固定 zh-CN 渲染，英文用例内切换语言；断言基于真实资源文本。
const i18n = createI18n('zh-CN')

vi.mock('../vocabulary/VocabularyPracticeDetail', () => ({
  VocabularyPracticeDetail: (): React.JSX.Element => (
    <section data-testid="vocabulary-practice-detail" />
  )
}))

vi.mock('../sentence/SentencePracticeDetail', () => ({
  SentencePracticeDetail: (): React.JSX.Element => (
    <section data-testid="sentence-practice-detail" />
  )
}))

function renderPage(onExit: () => void = vi.fn()): () => void {
  render(
    <I18nextProvider i18n={i18n}>
      <PracticePage onExit={onExit} />
    </I18nextProvider>
  )
  return onExit
}

afterEach(() => {
  cleanup()
  void i18n.changeLanguage('zh-CN')
})

describe('PracticePage', () => {
  it('renders the menu with vocabulary selected by default and its detail', () => {
    renderPage()

    expect(screen.getByRole('main', { name: '开始练习' })).toBeInTheDocument()
    const menu = screen.getByRole('navigation', { name: '练习菜单' })
    const items = within(menu).getAllByRole('button')
    expect(items).toHaveLength(2)
    expect(items[0]).toHaveTextContent('词汇练习')
    expect(items[0]).toHaveAttribute('aria-current', 'true')
    expect(items[1]).toHaveTextContent('造句练习')
    expect(items[1]).not.toHaveAttribute('aria-current')
    expect(screen.getByTestId('vocabulary-practice-detail')).toBeInTheDocument()
    expect(screen.queryByTestId('sentence-practice-detail')).not.toBeInTheDocument()
  })

  it('switches to the sentence practice detail through the menu', () => {
    renderPage()

    fireEvent.click(screen.getByRole('button', { name: '造句练习' }))

    const menu = screen.getByRole('navigation', { name: '练习菜单' })
    expect(within(menu).getAllByRole('button')[0]).not.toHaveAttribute('aria-current')
    expect(within(menu).getAllByRole('button')[1]).toHaveAttribute('aria-current', 'true')
    expect(screen.queryByTestId('vocabulary-practice-detail')).not.toBeInTheDocument()
    expect(screen.getByTestId('sentence-practice-detail')).toBeInTheDocument()
  })

  it('exits through the back button and Escape', () => {
    const onExit = renderPage(vi.fn())

    fireEvent.click(screen.getByRole('button', { name: '返回' }))
    expect(onExit).toHaveBeenCalledTimes(1)

    fireEvent.keyDown(screen.getByRole('main', { name: '开始练习' }), { key: 'Escape' })
    expect(onExit).toHaveBeenCalledTimes(2)

    // 其他按键不触发退出
    fireEvent.keyDown(screen.getByRole('main', { name: '开始练习' }), { key: 'Enter' })
    expect(onExit).toHaveBeenCalledTimes(2)
  })

  it('moves focus to the back button on entry', () => {
    renderPage()

    expect(screen.getByRole('button', { name: '返回' })).toHaveFocus()
  })

  it('renders accessible names in English', async () => {
    await i18n.changeLanguage('en')
    renderPage()

    expect(screen.getByRole('main', { name: 'Start practicing' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Back' })).toBeInTheDocument()
    const menu = screen.getByRole('navigation', { name: 'Practice menu' })
    expect(within(menu).getAllByRole('button', { name: 'Vocabulary practice' })).toHaveLength(1)
    expect(within(menu).getAllByRole('button', { name: 'Sentence practice' })).toHaveLength(1)
  })
})
