import './assets/main.css'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { I18nextProvider } from 'react-i18next'
import App from './App'
import { ErrorBoundary } from './components/ErrorBoundary'
import { installGlobalErrorReporting } from './error-reporting/installGlobalErrorReporting'
import { applyDocumentLanguage, createI18n } from './i18n'
import { loadStartupLocale } from './preferences/startup-locale'

// 全局异常（未捕获错误、未处理拒绝）进入 Main 的公共错误日志。
installGlobalErrorReporting()

// 挂载 React 前完成语言初始化，避免先渲染中文再跳到英文。
// 语言切换只调用 changeLanguage 触发重渲染，App 与控制器不会重建。
async function bootstrap(): Promise<void> {
  const startup = await loadStartupLocale()
  const i18n = createI18n(startup.locale)
  i18n.on('languageChanged', applyDocumentLanguage)
  applyDocumentLanguage(startup.locale)

  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <I18nextProvider i18n={i18n}>
        <ErrorBoundary>
          <App initialPreferenceError={startup.failed} />
        </ErrorBoundary>
      </I18nextProvider>
    </StrictMode>
  )
}

void bootstrap()
