import { useTranslation } from 'react-i18next'
import type { ActiveTest, ModelsDeleteState } from './useModelsSettings'
import type { ModelConfigSummary } from '../../../../shared/models'

interface ModelsTableProps {
  configs: ModelConfigSummary[]
  activeTest: ActiveTest | undefined
  deleteState: ModelsDeleteState
  deletingConfigId: string | undefined
  onEdit: (configId: string, event: React.MouseEvent<HTMLButtonElement>) => void
  onDelete: (configId: string, event: React.MouseEvent<HTMLButtonElement>) => void
  onTest: (configId: string) => void
}

// 已保存配置列表：原生 table，最右侧为固定操作列（删除／编辑／测试连通）。
// API Key 只显示 Main 生成的脱敏预览（前 4 位与后 4 位）或状态文案；
// 连接测试的结果不在表格内展示，由上层弹窗呈现。
export function ModelsTable({
  configs,
  activeTest,
  deleteState,
  deletingConfigId,
  onEdit,
  onDelete,
  onTest
}: ModelsTableProps): React.JSX.Element {
  const { t } = useTranslation('common')
  const testRunning = activeTest !== undefined

  return (
    <div className="models-table-wrap">
      <table className="models-table">
        <caption className="models-table-caption">{t('settings.models.tableCaption')}</caption>
        <thead>
          <tr>
            <th scope="col">{t('settings.models.columnModelId')}</th>
            <th scope="col">{t('settings.models.columnBaseUrl')}</th>
            <th scope="col">{t('settings.models.columnApiKey')}</th>
            <th className="models-table-actions" scope="col">
              {t('settings.models.columnActions')}
            </th>
          </tr>
        </thead>
        <tbody>
          {configs.map((config) => {
            const rowUnderTest = activeTest?.kind === 'row' && activeTest.configId === config.id
            const deleting = deletingConfigId === config.id && deleteState.kind === 'deleting'
            return (
              <tr key={config.id}>
                <td className="models-table-model-id">{config.modelId}</td>
                <td className="models-table-url-cell">
                  <span className="models-table-url" title={config.baseUrl}>
                    {config.baseUrl}
                  </span>
                </td>
                <td>
                  {config.apiKeyUndecryptable ? (
                    <span className="models-key-warning">
                      {t('settings.models.apiKeyUnavailable')}
                    </span>
                  ) : config.hasApiKey ? (
                    <span
                      aria-label={t('settings.models.apiKeyConfigured')}
                      className="models-key-mask"
                    >
                      {config.apiKeyPreview ?? t('settings.models.apiKeyMask')}
                    </span>
                  ) : (
                    <span className="models-key-missing">
                      {t('settings.models.apiKeyNotConfigured')}
                    </span>
                  )}
                </td>
                <td className="models-table-actions">
                  <div className="models-table-actions-group">
                    <button
                      disabled={deleting || rowUnderTest}
                      onClick={(event) => onDelete(config.id, event)}
                      type="button"
                    >
                      {deleting ? t('settings.models.deleting') : t('settings.models.deleteButton')}
                    </button>
                    <button
                      disabled={rowUnderTest}
                      onClick={(event) => onEdit(config.id, event)}
                      type="button"
                    >
                      {t('settings.models.editButton')}
                    </button>
                    <button
                      disabled={testRunning || deleting}
                      onClick={() => onTest(config.id)}
                      type="button"
                    >
                      {t('settings.models.testButton')}
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
