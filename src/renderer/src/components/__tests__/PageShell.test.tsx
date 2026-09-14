// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { useState } from 'react'
import { PageShell, type PageShellSection } from '../PageShell'

const SECTIONS: PageShellSection[] = [
  { id: 'alpha', label: '甲', content: <p>甲的内容</p> },
  { id: 'beta', label: '乙', content: <input aria-label="草稿" /> }
]

function renderShell(overrides: Partial<Parameters<typeof PageShell>[0]> = {}): {
  onExit: ReturnType<typeof vi.fn>
  onSectionChange: ReturnType<typeof vi.fn>
} {
  const onExit = vi.fn()
  const onSectionChange = vi.fn()
  render(
    <PageShell
      exitLabel="返回"
      menuLabel="页面菜单"
      onExit={onExit}
      onSectionChange={onSectionChange}
      sections={SECTIONS}
      title="示例页"
      {...overrides}
    />
  )
  return { onExit, onSectionChange }
}

afterEach(() => {
  cleanup()
})

describe('PageShell', () => {
  it('renders the menu with the first section active and its content', () => {
    renderShell()
    const main = screen.getByRole('main', { name: '示例页' })
    expect(main).toBeInTheDocument()
    expect(screen.getByRole('navigation', { name: '页面菜单' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '甲' })).toHaveAttribute('aria-current', 'true')
    expect(screen.getByRole('button', { name: '乙' })).not.toHaveAttribute('aria-current')
    expect(screen.getByText('甲的内容')).toBeInTheDocument()
    expect(screen.queryByLabelText('草稿')).not.toBeInTheDocument()
  })

  it('switches sections and unmounts inactive content by default', () => {
    const { onSectionChange } = renderShell()
    fireEvent.click(screen.getByRole('button', { name: '乙' }))
    expect(screen.getByRole('button', { name: '乙' })).toHaveAttribute('aria-current', 'true')
    expect(screen.getByLabelText('草稿')).toBeInTheDocument()
    expect(screen.queryByText('甲的内容')).not.toBeInTheDocument()
    expect(onSectionChange).toHaveBeenCalledWith('beta')
    // 重复点击同一项不触发切换回调
    fireEvent.click(screen.getByRole('button', { name: '乙' }))
    expect(onSectionChange).toHaveBeenCalledTimes(1)
  })

  it('keeps mounted sections in the DOM but hidden', () => {
    renderShell({
      sections: [
        {
          id: 'alpha',
          label: '甲',
          content: <input aria-label="草稿" />,
          keepMounted: true,
          labelledBy: 'alpha-title'
        },
        { id: 'beta', label: '乙', content: <p>乙的内容</p>, keepMounted: true }
      ]
    })
    const draft = screen.getByLabelText('草稿')
    const activePane = draft.closest('.page-shell-pane')
    expect(activePane).not.toHaveAttribute('hidden')
    expect(activePane).toHaveAttribute('aria-labelledby', 'alpha-title')
    const hiddenPane = screen.getByText('乙的内容').closest('.page-shell-pane')
    expect(hiddenPane).toHaveAttribute('hidden')
  })

  it('preserves drafts in a keepMounted pane across switches', () => {
    function Harness(): React.JSX.Element {
      const sections: PageShellSection[] = [
        {
          id: 'form',
          label: '表单',
          keepMounted: true,
          content: (
            <>
              <h2 id="form-title">表单</h2>
              <DraftInput />
            </>
          )
        },
        { id: 'other', label: '其他', content: <p>其他内容</p> }
      ]
      return (
        <PageShell
          exitLabel="返回"
          menuLabel="菜单"
          onExit={() => {}}
          sections={sections}
          title="页"
        />
      )
    }
    function DraftInput(): React.JSX.Element {
      const [value, setValue] = useState('')
      return <input aria-label="草稿" onChange={(e) => setValue(e.target.value)} value={value} />
    }
    render(<Harness />)
    fireEvent.change(screen.getByLabelText('草稿'), { target: { value: '保留我' } })
    fireEvent.click(screen.getByRole('button', { name: '其他' }))
    fireEvent.click(screen.getByRole('button', { name: '表单' }))
    expect(screen.getByLabelText('草稿')).toHaveValue('保留我')
  })

  it('focuses the back button on mount and exits via click or Escape', () => {
    const { onExit } = renderShell()
    expect(screen.getByRole('button', { name: '返回' })).toHaveFocus()
    fireEvent.click(screen.getByRole('button', { name: '返回' }))
    expect(onExit).toHaveBeenCalledTimes(1)
    fireEvent.keyDown(screen.getByRole('main', { name: '示例页' }), { key: 'Escape' })
    expect(onExit).toHaveBeenCalledTimes(2)
  })

  it('delegates Escape to onEscape when provided', () => {
    const onEscape = vi.fn()
    const { onExit } = renderShell({ onEscape })
    fireEvent.keyDown(screen.getByRole('main', { name: '示例页' }), { key: 'Escape' })
    expect(onEscape).toHaveBeenCalledTimes(1)
    expect(onExit).not.toHaveBeenCalled()
  })

  it('applies the page class hook', () => {
    renderShell({ className: 'settings-page' })
    expect(screen.getByRole('main', { name: '示例页' })).toHaveClass('page-shell', 'settings-page')
  })
})
