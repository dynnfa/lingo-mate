// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { useRef, useState } from 'react'
import { ConfirmDialog, type ConfirmDialogProps } from '../ConfirmDialog'

function renderDialog(overrides: Partial<ConfirmDialogProps> = {}): {
  props: ConfirmDialogProps
  pageKeyDown: ReturnType<typeof vi.fn>
} {
  const props: ConfirmDialogProps = {
    open: true,
    title: '删除记录？',
    description: '该操作不可撤销。',
    confirmLabel: '删除',
    cancelLabel: '取消',
    onConfirm: vi.fn(),
    onCancel: vi.fn(),
    ...overrides
  }
  const pageKeyDown = vi.fn()
  render(
    <div data-testid="page" onKeyDown={pageKeyDown}>
      <ConfirmDialog {...props} />
    </div>
  )
  return { props, pageKeyDown }
}

afterEach(() => {
  cleanup()
})

describe('ConfirmDialog', () => {
  it('renders an accessible modal dialog and renders nothing when closed', () => {
    renderDialog()
    const dialog = screen.getByRole('dialog', { name: '删除记录？' })
    expect(dialog).toHaveAttribute('aria-modal', 'true')
    expect(within(dialog).getByText('该操作不可撤销。')).toBeInTheDocument()

    cleanup()
    renderDialog({ open: false })
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('invokes onConfirm / onCancel from the action buttons', () => {
    const { props } = renderDialog()
    fireEvent.click(screen.getByRole('button', { name: '删除' }))
    expect(props.onConfirm).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    expect(props.onCancel).toHaveBeenCalledTimes(1)
  })

  it('closes on Escape without bubbling to the page', () => {
    const { props, pageKeyDown } = renderDialog()
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    expect(props.onCancel).toHaveBeenCalledTimes(1)
    expect(props.onConfirm).not.toHaveBeenCalled()
    expect(pageKeyDown).not.toHaveBeenCalled()
  })

  it('focuses the cancel button by default and the confirm button when requested', () => {
    renderDialog()
    expect(screen.getByRole('button', { name: '取消' })).toHaveFocus()

    cleanup()
    renderDialog({ initialFocus: 'confirm' })
    expect(screen.getByRole('button', { name: '删除' })).toHaveFocus()
  })

  it('cycles focus within the dialog on Tab and Shift+Tab', () => {
    renderDialog()
    const cancel = screen.getByRole('button', { name: '取消' })
    const confirm = screen.getByRole('button', { name: '删除' })
    const dialog = screen.getByRole('dialog')

    // jsdom 不执行原生 Tab 移动，直接验证环绕：末位 Tab 回到首位，
    // 首位 Shift+Tab 回到末位。
    confirm.focus()
    fireEvent.keyDown(dialog, { key: 'Tab' })
    expect(cancel).toHaveFocus()
    fireEvent.keyDown(dialog, { key: 'Tab', shiftKey: true })
    expect(confirm).toHaveFocus()
  })

  it('returns focus to the returnFocusRef target after closing', () => {
    function Harness(): React.JSX.Element {
      const openerRef = useRef<HTMLButtonElement>(null)
      const [open, setOpen] = useState(true)
      return (
        <>
          <button onClick={() => setOpen(false)} ref={openerRef} type="button">
            触发按钮
          </button>
          <ConfirmDialog
            cancelLabel="取消"
            confirmLabel="删除"
            onCancel={() => setOpen(false)}
            onConfirm={() => setOpen(false)}
            open={open}
            returnFocusRef={openerRef}
            title="删除记录？"
          />
        </>
      )
    }
    render(<Harness />)
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '触发按钮' })).toHaveFocus()
  })

  it('disables both buttons and ignores Escape while busy', () => {
    const { props, pageKeyDown } = renderDialog({ busy: true })
    expect(screen.getByRole('button', { name: '删除' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '取消' })).toBeDisabled()
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    expect(props.onCancel).not.toHaveBeenCalled()
    expect(pageKeyDown).not.toHaveBeenCalled()
  })

  it('renders the error message as an alert above the actions', () => {
    renderDialog({ error: '删除失败，请重试。' })
    expect(screen.getByRole('alert')).toHaveTextContent('删除失败，请重试。')
  })

  it('renders a single confirm button when cancelLabel is omitted', () => {
    const { props } = renderDialog({ cancelLabel: undefined })
    expect(screen.getByRole('button', { name: '删除' })).toHaveFocus()
    expect(screen.queryByRole('button', { name: '取消' })).not.toBeInTheDocument()
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    expect(props.onCancel).toHaveBeenCalledTimes(1)
  })

  it('renders extra children between description and error', () => {
    renderDialog({ children: <p>附加说明</p>, error: '失败' })
    const dialog = screen.getByRole('dialog')
    expect(within(dialog).getByText('附加说明')).toBeInTheDocument()
    expect(within(dialog).getByRole('alert')).toBeInTheDocument()
  })
})
