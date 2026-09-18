import type { RendererErrorReport } from '../../../shared/error-report'

// Renderer 侧错误上报：尽力送达 Main 的公共错误日志。任何失败（接口缺失、
// IPC 拒绝、限流）都静默放弃——上报通道自身绝不能再抛出错误。
export function reportErrorToMain(report: RendererErrorReport): void {
  try {
    const api = (
      window as typeof window & {
        api?: { reportError?: (report: RendererErrorReport) => Promise<unknown> }
      }
    ).api
    void api?.reportError?.(report)?.catch(() => {})
  } catch {
    // window.api 未注入或不可用：放弃上报。
  }
}
