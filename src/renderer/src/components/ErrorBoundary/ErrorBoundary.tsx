import { Component, type ErrorInfo, type ReactNode } from 'react'
import { ErrorFallback } from './ErrorFallback'
import { reportErrorToMain } from '../../error-reporting/reportErrorToMain'

interface ErrorBoundaryProps {
  children: ReactNode
}

interface ErrorBoundaryState {
  hasError: boolean
}

// 顶层 React 错误边界：渲染期异常降级为整页错误块（可重新加载），并把
// 异常与组件栈上报 Main 的公共错误日志；UI 错误不再静默消失。
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { hasError: false }

  static getDerivedStateFromError(): ErrorBoundaryState {
    return { hasError: true }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    reportErrorToMain({
      source: 'renderer',
      module: 'react',
      operation: 'error-boundary',
      message: error.message || 'render error',
      stack: error.stack,
      context: info.componentStack == null ? undefined : { componentStack: info.componentStack }
    })
  }

  render(): ReactNode {
    return this.state.hasError ? <ErrorFallback /> : this.props.children
  }
}
