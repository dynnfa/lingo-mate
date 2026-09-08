// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { I18nextProvider } from 'react-i18next'
import { createI18n } from '../../i18n'
import { RecordedPage } from '../RecordedPage'

// 组件测试固定 zh-CN 渲染，英文用例内切换语言；断言基于真实资源文本。
const i18n = createI18n('zh-CN')

function renderPage(onExit: () => void = vi.fn()): () => void {
  render(
    <I18nextProvider i18n={i18n}>
      <RecordedPage onExit={onExit} />
    </I18nextProvider>
  )
  return onExit
}

afterEach(() => {
  cleanup()
  void i18n.changeLanguage('zh-CN')
})

describe('RecordedPage', () => {
  it('renders only the vocabulary menu item and it is selected by default', () => {
    renderPage()

    const menu = screen.getByRole('navigation', { name: '已记录词汇菜单' })
    const items = within(menu).getAllByRole('button')
    expect(items).toHaveLength(1)
    expect(items[0]).toHaveTextContent('词汇')
    expect(items[0]).toHaveAttribute('aria-current', 'true')
    expect(screen.getByRole('main', { name: '已记录词汇' })).toBeInTheDocument()
  })

  it('keeps the right content container present but empty', () => {
    renderPage()

    const detail = document.querySelector('.recorded-detail')
    expect(detail).toBeInstanceOf(HTMLElement)
    expect(detail).toBeEmptyDOMElement()
  })

  it('exits through the back button and Escape', () => {
    const onExit = renderPage(vi.fn())

    fireEvent.click(screen.getByRole('button', { name: '返回' }))
    expect(onExit).toHaveBeenCalledTimes(1)

    fireEvent.keyDown(screen.getByRole('main', { name: '已记录词汇' }), { key: 'Escape' })
    expect(onExit).toHaveBeenCalledTimes(2)

    // 其他按键不触发退出
    fireEvent.keyDown(screen.getByRole('main', { name: '已记录词汇' }), { key: 'Enter' })
    expect(onExit).toHaveBeenCalledTimes(2)
  })

  it('moves focus to the back button on entry', () => {
    renderPage()

    expect(screen.getByRole('button', { name: '返回' })).toHaveFocus()
  })

  it('repeats menu clicks without exiting or re-rendering content', () => {
    const onExit = renderPage(vi.fn())

    fireEvent.click(
      within(screen.getByRole('navigation', { name: '已记录词汇菜单' })).getAllByRole('button')[0]
    )
    fireEvent.click(
      within(screen.getByRole('navigation', { name: '已记录词汇菜单' })).getAllByRole('button')[0]
    )

    expect(screen.getByRole('main', { name: '已记录词汇' })).toBeInTheDocument()
    expect(onExit).not.toHaveBeenCalled()
  })

  it('renders accessible names in English', async () => {
    await i18n.changeLanguage('en')
    renderPage()

    expect(screen.getByRole('main', { name: 'Recorded vocabulary' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Back' })).toBeInTheDocument()
    expect(
      within(screen.getByRole('navigation', { name: 'Recorded vocabulary menu' })).getByRole(
        'button',
        {
          name: 'Vocabulary'
        }
      )
    ).toHaveAttribute('aria-current', 'true')
  })
})
