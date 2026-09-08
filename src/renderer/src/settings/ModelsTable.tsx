import { useTranslation } from 'react-i18next'
import { modelsErrorKey } from './models-messages'
import type { ActiveTest, ModelsDeleteState, ModelsTestOutcome } from './useModelsSettings'
import type { ModelConfigSummary } from '../../../shared/models'

interface ModelsTableProps {
  configs: ModelConfigSummary[]
  rowTests: Record<string, ModelsTestOutcome>
  activeTest: ActiveTest | undefined
  deleteState: ModelsDeleteState
  deletingConfigId: string | undefined
  onEdit: (configId: string, event: React.MouseEvent<HTMLButtonElement>) => void
  onDelete: (configId: string, event: React.MouseEvent<HTMLButtonElement>) => void
  onTest: (configId: string) => void
}

// 已保存配置列表：原生 table，最右侧为固定操作列（删除／编辑／测试连通）。
// API Key 只显示 Main 生成的脱敏预览（前 4 位与后 4 位）或状态文案；测试状态逐行归属展示。
export function ModelsTable({
  configs,
  rowTests,
  activeTest,
  deleteState,
  deletingConfigId,
  onEdit,
  onDelete,
  onTest
}: ModelsTableProps): React.JSX.Element {
  const { t } = useTranslation(['common', 'errors'])
  const testRunning = activeTest !== undefined

  return (
    <div className="models-table-wrap">
      <table className="models-table">
        <caption className="models-table-caption">
          {t('common:settings.models.tableCaption')}
        </caption>
        <thead>
          <tr>
            <th scope="col">{t('common:settings.models.columnModelId')}</th>
            <th scope="col">{t('common:settings.models.columnBaseUrl')}</th>
            <th scope="col">{t('common:settings.models.columnProtocol')}</th>
            <th scope="col">{t('common:settings.models.columnApiKey')}</th>
            <th scope="col">{t('common:settings.models.columnTestStatus')}</th>
            <th className="models-table-actions" scope="col">
              {t('common:settings.models.columnActions')}
            </th>
          </tr>
        </thead>
        <tbody>
          {configs.map((config) => {
            const outcome = rowTests[config.id]
            const rowUnderTest = activeTest?.kind === 'row' && activeTest.configId === config.id
            const deleting = deletingConfigId === config.id && deleteState.kind === 'deleting'
            const statusText = (() => {
              if (outcome === undefined || outcome.status === 'idle') {
                return t('common:settings.models.testStateUntested')
              }
              if (outcome.status === 'running') {
                return t('common:settings.models.testStateRunning')
              }
              if (outcome.status === 'succeeded') {
                return t('common:settings.models.testStateSucceeded')
              }
              if (outcome.status === 'cancelled') {
                return t('common:settings.models.testStateCancelled')
              }
              return t(modelsErrorKey(outcome.code))
            })()
            const failed = outcome?.status === 'failed'
            return (
              <tr key={config.id}>
                <td className="models-table-model-id">{config.modelId}</td>
                <td className="models-table-url-cell">
                  <span className="models-table-url" title={config.baseUrl}>
                    {config.baseUrl}
                  </span>
                </td>
                <td>{t('common:settings.models.protocolOpenAICompatible')}</td>
                <td>
                  {config.apiKeyUndecryptable ? (
                    <span className="models-key-warning">
                      {t('common:settings.models.apiKeyUnavailable')}
                    </span>
                  ) : config.hasApiKey ? (
                    <span
                      aria-label={t('common:settings.models.apiKeyConfigured')}
                      className="models-key-mask"
                    >
                      {config.apiKeyPreview ?? t('common:settings.models.apiKeyMask')}
                    </span>
                  ) : (
                    <span className="models-key-missing">
                      {t('common:settings.models.apiKeyNotConfigured')}
                    </span>
                  )}
                </td>
                <td className={failed ? 'models-table-test-failed' : undefined}>
                  <span
                    aria-live={outcome?.status === 'running' ? 'polite' : undefined}
                    role={outcome?.status === 'running' ? 'status' : undefined}
                  >
                    {statusText}
                  </span>
                </td>
                <td className="models-table-actions">
                  <div className="models-table-actions-group">
                    <button
                      disabled={deleting || rowUnderTest}
                      onClick={(event) => onDelete(config.id, event)}
                      type="button"
                    >
                      {deleting
                        ? t('common:settings.models.deleting')
                        : t('common:settings.models.deleteButton')}
                    </button>
                    <button
                      disabled={rowUnderTest}
                      onClick={(event) => onEdit(config.id, event)}
                      type="button"
                    >
                      {t('common:settings.models.editButton')}
                    </button>
                    <button
                      disabled={testRunning || deleting}
                      onClick={() => onTest(config.id)}
                      type="button"
                    >
                      {t('common:settings.models.testButton')}
                    </button>
                  </div>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
