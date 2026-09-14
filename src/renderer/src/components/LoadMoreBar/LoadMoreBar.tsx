import './LoadMoreBar.css'

export interface LoadMoreBarError {
  title: string
  message: string
}

export interface LoadMoreBarProps {
  hasMore: boolean
  loadingMore: boolean
  error: LoadMoreBarError | null
  loadingLabel: string
  retryLabel: string
  label: string
  onLoadMore: () => void
}

// 列表底部加载区三态：失败提示（role=alert + 重试）、加载中状态与加载更多按钮。
// 组件不持有文案，全部由调用方翻译后传入。
export function LoadMoreBar({
  hasMore,
  loadingMore,
  error,
  loadingLabel,
  retryLabel,
  label,
  onLoadMore
}: LoadMoreBarProps): React.JSX.Element {
  return (
    <footer className="load-more-bar">
      {error ? (
        <div className="load-more-error" role="alert">
          <p className="load-more-error-title">{error.title}</p>
          <p>{error.message}</p>
          <button disabled={loadingMore} onClick={onLoadMore} type="button">
            {retryLabel}
          </button>
        </div>
      ) : null}
      {loadingMore ? (
        <p aria-live="polite" className="load-more-status" role="status">
          {loadingLabel}
        </p>
      ) : hasMore ? (
        <button className="load-more-button" onClick={onLoadMore} type="button">
          {label}
        </button>
      ) : null}
    </footer>
  )
}
