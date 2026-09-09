// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { I18nextProvider } from 'react-i18next'
import { createI18n } from '../../i18n'
import { PracticePage } from '../PracticePage'

// 组件测试固定 zh-CN 渲染，英文用例内切换语言；断言基于真实资源文本。
const i18n = createI18n('zh-CN')

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
  it('renders the page with an empty menu and detail container', () => {
    renderPage()

    expect(screen.getByRole('main', { name: '开始练习' })).toBeInTheDocument()
    const menu = screen.getByRole('navigation', { name: '练习菜单' })
    expect(within(menu).queryAllByRole('button')).toHaveLength(0)
    const detail = document.querySelector('.practice-detail')
    expect(detail).toBeInstanceOf(HTMLElement)
    expect(detail).toBeEmptyDOMElement()
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
    expect(
      within(screen.getByRole('navigation', { name: 'Practice menu' })).queryAllByRole('button')
    ).toHaveLength(0)
  })
})
