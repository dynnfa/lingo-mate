import type { ReactNode } from 'react'
import './StateBlock.css'

export interface StateBlockProps {
  variant: 'loading' | 'empty' | 'error'
  // 标题段：empty/error 场景的主文案。
  title?: string
  message?: string
  // 仅 error：渲染重试按钮。
  onRetry?: () => void
  retryLabel?: string
  // 仅 loading：渲染骨架占位（usage 首次加载），message 改作 aria-label。
  skeleton?: boolean
  // 无可见文本时（骨架）的容器可访问名称。
  ariaLabel?: string
  // 站点皮肤钩子：间距与边框等差异由调用方附加。
  className?: string
  // 额外正文（如练习空态的数量提示、用量时间线）。
  children?: ReactNode
}

// 跨 menu 共享的页面级三态块：loading（role=status + aria-busy）、
// error（role=alert + 可选重试）、empty（无特殊 role）。
// 组件不持有文案，所有 label/message 由调用方翻译后传入。
export function StateBlock({
  variant,
  title,
  message,
  onRetry,
  retryLabel,
  skeleton = false,
  ariaLabel,
  className,
  children
}: StateBlockProps): React.JSX.Element {
  return (
    <div
      aria-busy={variant === 'loading' || undefined}
      aria-label={ariaLabel}
      className={
        className
          ? `state-block state-block-${variant} ${className}`
          : `state-block state-block-${variant}`
      }
      role={variant === 'loading' ? 'status' : variant === 'error' ? 'alert' : undefined}
    >
      {skeleton ? (
        <div aria-hidden="true" className="state-block-skeleton">
          <div className="state-block-skeleton-summary">
            <span className="state-block-skeleton-block" />
            <span className="state-block-skeleton-block" />
          </div>
          <span className="state-block-skeleton-block state-block-skeleton-chart" />
        </div>
      ) : null}
      {title !== undefined ? <p className="state-block-title">{title}</p> : null}
      {message !== undefined ? <p className="state-block-message">{message}</p> : null}
      {children}
      {variant === 'error' && onRetry !== undefined ? (
        <button onClick={onRetry} type="button">
          {retryLabel}
        </button>
      ) : null}
    </div>
  )
}
