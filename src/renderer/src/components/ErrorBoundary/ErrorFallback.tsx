import { useTranslation } from 'react-i18next'
import { StateBlock } from '../StateBlock'

// 错误边界的整页回退：文案来自 errors 资源，重试即整页重载。
export function ErrorFallback(): React.JSX.Element {
  const { t } = useTranslation(['common', 'errors'])
  return (
    <StateBlock
      variant="error"
      title={t('errors:boundary.title')}
      message={t('errors:boundary.description')}
      onRetry={() => window.location.reload()}
      retryLabel={t('errors:boundary.reload')}
    />
  )
}
