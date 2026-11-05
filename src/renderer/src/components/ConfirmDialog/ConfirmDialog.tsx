import { useEffect, useId, useRef, type KeyboardEvent, type ReactNode, type RefObject } from 'react'
import { useFocusTrap } from './useFocusTrap'
import './ConfirmDialog.css'

export interface ConfirmDialogProps {
  open: boolean
  title: string
  description?: string
  confirmLabel: string
  // 省略时只渲染确认按钮（单按钮结果弹窗）。
  cancelLabel?: string
  // danger 决定确认按钮使用主操作样式；默认次级样式。
  tone?: 'default' | 'danger'
  // true 时双按钮禁用（删除进行中），Escape 同样被忽略。
  busy?: boolean
  // 操作失败文案，按钮上方以 role="alert" 渲染。
  error?: string | null
  initialFocus?: 'confirm' | 'cancel'
  initialFocusRef?: RefObject<HTMLElement | null>
  formId?: string
  confirmDisabled?: boolean
  // 关闭后焦点归还目标。
  returnFocusRef?: RefObject<HTMLElement | null>
  onConfirm?: () => void
  onCancel: () => void
  // 附加内容插槽，渲染在描述与错误之间（如模型行测试结果）。
  children?: ReactNode
}

// 跨 menu 共享的确认对话框：遮罩 + role="dialog" + aria-modal + 焦点陷阱。
// 组件不持有文案，所有 label/message 由调用方翻译后传入。
export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel,
  cancelLabel,
  tone = 'default',
  busy = false,
  error = null,
  initialFocus = 'cancel',
  initialFocusRef,
  formId,
  confirmDisabled = false,
  returnFocusRef,
  onConfirm,
  onCancel,
  children
}: ConfirmDialogProps): React.JSX.Element | null {
  const titleId = useId()
  const descriptionId = useId()
  const backdropRef = useRef<HTMLDivElement>(null)
  const dialogRef = useRef<HTMLDivElement>(null)
  const confirmRef = useRef<HTMLButtonElement>(null)
  const cancelRef = useRef<HTMLButtonElement>(null)
  const hasCancelButton = cancelLabel !== undefined
  const buttonFocusRef = initialFocus === 'confirm' || !hasCancelButton ? confirmRef : cancelRef
  const focusRef = initialFocusRef ?? buttonFocusRef
  useFocusTrap({
    active: open,
    containerRef: backdropRef,
    initialFocusRef: focusRef,
    returnFocusRef
  })

  useEffect(() => {
    if (!open) return
    if (busy) dialogRef.current?.focus()
    else if (document.activeElement === dialogRef.current) focusRef.current?.focus()
  }, [busy, focusRef, open])

  if (!open) return null

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== 'Escape') return
    // 对话框打开期间 Escape 一律吞在遮罩层，不冒泡触发页面级退出；
    // busy 时仅忽略，不转发。
    event.preventDefault()
    event.stopPropagation()
    if (!busy) onCancel()
  }

  return (
    <div className="confirm-backdrop" onKeyDown={handleKeyDown} ref={backdropRef}>
      <div
        aria-describedby={description !== undefined ? descriptionId : undefined}
        aria-labelledby={titleId}
        aria-modal="true"
        className="confirm-card"
        ref={dialogRef}
        role="dialog"
        tabIndex={-1}
      >
        <h3 id={titleId}>{title}</h3>
        {description !== undefined ? (
          <p className="confirm-text" id={descriptionId}>
            {description}
          </p>
        ) : null}
        {children}
        {error ? (
          <p className="confirm-text confirm-error" role="alert">
            {error}
          </p>
        ) : null}
        <div className="confirm-actions">
          {hasCancelButton ? (
            <button
              className="confirm-cancel-button"
              disabled={busy}
              onClick={onCancel}
              ref={cancelRef}
              type="button"
            >
              {cancelLabel}
            </button>
          ) : null}
          <button
            className={tone === 'danger' ? 'confirm-button-danger' : 'confirm-button'}
            disabled={busy || confirmDisabled}
            form={formId}
            onClick={onConfirm}
            ref={confirmRef}
            type={formId ? 'submit' : 'button'}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
