// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { StateBlock } from '../StateBlock'

afterEach(() => {
  cleanup()
})

describe('StateBlock', () => {
  it('renders the loading variant with status semantics', () => {
    render(<StateBlock message="正在加载…" variant="loading" />)
    const block = screen.getByRole('status')
    expect(block).toHaveTextContent('正在加载…')
    expect(block).toHaveAttribute('aria-busy', 'true')
  })

  it('renders the error variant with alert semantics and a retry button', () => {
    const onRetry = vi.fn()
    render(
      <StateBlock
        message="访问本地数据失败。"
        onRetry={onRetry}
        retryLabel="重试"
        title="词汇读取失败"
        variant="error"
      />
    )
    const block = screen.getByRole('alert')
    expect(block).toHaveTextContent('词汇读取失败')
    expect(block).toHaveTextContent('访问本地数据失败。')
    fireEvent.click(screen.getByRole('button', { name: '重试' }))
    expect(onRetry).toHaveBeenCalledTimes(1)
  })

  it('renders the empty variant without live-region semantics', () => {
    render(
      <StateBlock message="在对话中使用命令收藏单词。" title="还没有收藏词汇" variant="empty" />
    )
    const block = screen.getByText('还没有收藏词汇').parentElement
    expect(block).not.toHaveAttribute('role')
    expect(block).not.toHaveAttribute('aria-busy')
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })

  it('renders the skeleton placeholder with an accessible name', () => {
    render(<StateBlock ariaLabel="正在加载用量数据" skeleton variant="loading" />)
    const block = screen.getByRole('status')
    expect(block).toHaveAttribute('aria-label', '正在加载用量数据')
    expect(block).toHaveAttribute('aria-busy', 'true')
    expect(block.textContent).toBe('')
  })

  it('appends the site class and renders extra children', () => {
    render(
      <StateBlock className="models-empty" title="还没有内容" variant="empty">
        <p>附加说明</p>
      </StateBlock>
    )
    const block = screen.getByText('还没有内容').parentElement
    expect(block).toHaveClass('state-block', 'state-block-empty', 'models-empty')
    expect(screen.getByText('附加说明')).toBeInTheDocument()
  })
})
