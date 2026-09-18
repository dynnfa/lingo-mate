import { reportErrorToMain } from './reportErrorToMain'

// 浏览器全局异常采集：未捕获异常与未处理拒绝上报到 Main 的公共错误日志。
// 只安装一次；资源加载失败（无 error 对象且 target 非 window）不上报。
let installed = false

export function installGlobalErrorReporting(): void {
  if (installed) return
  installed = true

  window.addEventListener('error', (event) => {
    const error = event.error
    if (error instanceof Error) {
      reportErrorToMain({
        source: 'renderer',
        module: 'global',
        operation: 'uncaught-error',
        message: error.message || 'uncaught error',
        stack: error.stack
      })
      return
    }
    if (!event.target || event.target === (window as unknown as EventTarget)) {
      reportErrorToMain({
        source: 'renderer',
        module: 'global',
        operation: 'uncaught-error',
        message: event.message || 'uncaught error'
      })
    }
  })

  window.addEventListener('unhandledrejection', (event) => {
    const reason = event.reason
    reportErrorToMain({
      source: 'renderer',
      module: 'global',
      operation: 'unhandled-rejection',
      message:
        reason instanceof Error
          ? reason.message || 'unhandled rejection'
          : typeof reason === 'string' && reason.length > 0
            ? reason
            : 'unhandled rejection',
      stack: reason instanceof Error ? reason.stack : undefined
    })
  })
}
