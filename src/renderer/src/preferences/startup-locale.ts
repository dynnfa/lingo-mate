import type { SupportedLocale } from '../../../shared/preferences'
import { normalizeI18nLocale } from '../i18n'

const STARTUP_TIMEOUT_MS = 3_000

export interface StartupLocale {
  locale: SupportedLocale
  failed: boolean
}

// 挂载 React 前读取界面语言：偏好 IPC 拒绝、返回非法数据或超时都以
// 打包的 zh-CN 资源继续启动，不阻塞、不白屏；过期响应直接忽略。
export async function loadStartupLocale(): Promise<StartupLocale> {
  try {
    const result = await withTimeout(window.api.preferences.getLocale(), STARTUP_TIMEOUT_MS)
    if (result.status === 'ok') {
      return { locale: normalizeI18nLocale(result.settings.resolvedLocale), failed: false }
    }
  } catch {
    // 读取失败或超时：回退默认语言并提示
  }
  return { locale: 'zh-CN', failed: true }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('locale preference timed out')), timeoutMs)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error: unknown) => {
        clearTimeout(timer)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    )
  })
}
