import { useTranslation } from 'react-i18next'
import { modelsClearErrorKey, modelsErrorKey } from './models-messages'
import type { ModelsSettingsState } from './useModelsSettings'

// 设置页“模型”区块：读取安全配置摘要，展示 LLM 表单并承担
// 保存 / 测试连接 / 清除操作与状态提示。状态本体由 SettingsPage 通过
// useModelsSettings 持有，区块随菜单切换卸载时草稿不丢失。
export function ModelsSettings({ state }: { state: ModelsSettingsState }): React.JSX.Element {
  const { t } = useTranslation(['common', 'errors'])
  const { loadState, retryLoad, summary, draft, fieldIssues, saveState, testOutcome, clearState } =
    state
  const configured = summary?.configured === true
  const formLocked = state.busy || loadState !== 'ready'

  if (loadState === 'loading') {
    return <p className="models-loading">{t('common:settings.models.loading')}</p>
  }

  if (loadState === 'error') {
    return (
      <div className="models-load-error">
        <p className="settings-error" role="alert">
          {t('errors:models.readFailed')}
        </p>
        <button onClick={retryLoad} type="button">
          {t('common:settings.models.retryLoad')}
        </button>
      </div>
    )
  }

  const saveMessage = (() => {
    if (saveState.kind === 'saving') return t('common:settings.models.saving')
    if (saveState.kind === 'saved') return t('common:settings.models.saved')
    if (saveState.kind === 'failed') return t(modelsErrorKey(saveState.code))
    return undefined
  })()
  const testMessage = (() => {
    if (testOutcome.status === 'running') return t('common:settings.models.testRunning')
    if (testOutcome.status === 'succeeded') return t('common:settings.models.testSucceeded')
    if (testOutcome.status === 'failed') return t(modelsErrorKey(testOutcome.code))
    return undefined
  })()

  return (
    <form
      className="models-form"
      noValidate
      onSubmit={(event) => {
        event.preventDefault()
        state.save()
      }}
    >
      <p className="settings-section-description">{t('common:settings.models.description')}</p>

      <fieldset className="models-fieldset" disabled={formLocked}>
        <div className="models-field">
          <span className="models-field-label">{t('common:settings.models.protocolLabel')}</span>
          <span className="models-static-value">
            {t('common:settings.models.protocolOpenAICompatible')}
          </span>
        </div>

        <div className="models-field">
          <label htmlFor="models-base-url">{t('common:settings.models.baseUrlLabel')}</label>
          <input
            aria-describedby={fieldIssues.baseUrl ? 'models-base-url-error' : undefined}
            aria-invalid={fieldIssues.baseUrl !== undefined}
            autoComplete="off"
            id="models-base-url"
            onChange={(event) => state.setDraftField('baseUrl', event.target.value)}
            placeholder={t('common:settings.models.baseUrlPlaceholder')}
            spellCheck={false}
            type="text"
            value={draft.baseUrl}
          />
          {fieldIssues.baseUrl ? (
            <p className="models-field-error" id="models-base-url-error">
              {t(modelsErrorKey(fieldIssues.baseUrl))}
            </p>
          ) : null}
        </div>

        <div className="models-field">
          <label htmlFor="models-model-id">{t('common:settings.models.modelIdLabel')}</label>
          <input
            aria-describedby={fieldIssues.modelId ? 'models-model-id-error' : undefined}
            aria-invalid={fieldIssues.modelId !== undefined}
            autoComplete="off"
            id="models-model-id"
            onChange={(event) => state.setDraftField('modelId', event.target.value)}
            placeholder={t('common:settings.models.modelIdPlaceholder')}
            spellCheck={false}
            type="text"
            value={draft.modelId}
          />
          {fieldIssues.modelId ? (
            <p className="models-field-error" id="models-model-id-error">
              {t(modelsErrorKey(fieldIssues.modelId))}
            </p>
          ) : null}
        </div>

        <div className="models-field">
          <label htmlFor="models-api-key">{t('common:settings.models.apiKeyLabel')}</label>
          <input
            aria-describedby={fieldIssues.apiKey ? 'models-api-key-error' : 'models-api-key-hint'}
            aria-invalid={fieldIssues.apiKey !== undefined}
            autoComplete="new-password"
            id="models-api-key"
            onChange={(event) => state.setDraftField('apiKey', event.target.value)}
            placeholder={t('common:settings.models.apiKeyPlaceholder')}
            type="password"
            value={draft.apiKey}
          />
          <p className="models-field-hint" id="models-api-key-hint">
            {configured && summary.hasApiKey
              ? t('common:settings.models.apiKeyKeepHint')
              : t('common:settings.models.apiKeyOptionalHint')}
          </p>
          {fieldIssues.apiKey ? (
            <p className="models-field-error" id="models-api-key-error">
              {t(modelsErrorKey(fieldIssues.apiKey))}
            </p>
          ) : null}
        </div>

        {configured ? (
          <div className="models-key-status">
            <span className="models-key-status-label">
              {t('common:settings.models.apiKeyStatusLabel')}
            </span>
            {summary.apiKeyUndecryptable ? (
              <span className="models-key-warning" role="alert">
                {t('common:settings.models.apiKeyUndecryptable')}
              </span>
            ) : summary.hasApiKey ? (
              <span className="models-key-configured">
                {t('common:settings.models.apiKeyConfigured')}
              </span>
            ) : (
              <span className="models-key-missing">
                {t('common:settings.models.apiKeyNotConfigured')}
              </span>
            )}
            {summary.hasApiKey || summary.apiKeyUndecryptable ? (
              <label className="models-remove-key">
                <input
                  checked={draft.removeStoredKey}
                  onChange={(event) => state.setDraftField('removeStoredKey', event.target.checked)}
                  type="checkbox"
                />
                {t('common:settings.models.removeStoredKey')}
              </label>
            ) : null}
          </div>
        ) : null}

        <div className="models-actions">
          <button disabled={formLocked} onClick={state.test} type="button">
            {t('common:settings.models.testButton')}
          </button>
          <button disabled={formLocked || !state.dirty} type="submit">
            {t('common:settings.models.saveButton')}
          </button>
          {configured ? (
            <button disabled={formLocked} onClick={state.requestClear} type="button">
              {t('common:settings.models.clearButton')}
            </button>
          ) : null}
        </div>

        <p className="models-test-hint">{t('common:settings.models.testHint')}</p>

        <div aria-live="polite" className="models-status" role="status">
          {saveMessage ? <p>{saveMessage}</p> : null}
          {testMessage ? <p>{testMessage}</p> : null}
        </div>

        {clearState.kind === 'failed' ? (
          <p className="settings-error" role="alert">
            {t(modelsClearErrorKey(clearState.code))}
          </p>
        ) : null}
      </fieldset>

      {clearState.kind === 'confirming' ? (
        <div
          aria-describedby="models-clear-confirm-body"
          aria-labelledby="models-clear-confirm-title"
          className="settings-confirm"
          role="dialog"
        >
          <h3 id="models-clear-confirm-title">{t('common:settings.models.clearConfirmTitle')}</h3>
          <p id="models-clear-confirm-body">{t('common:settings.models.clearConfirmBody')}</p>
          <div className="settings-confirm-actions">
            <button onClick={state.cancelClear} type="button">
              {t('common:settings.models.clearConfirmCancel')}
            </button>
            <button className="settings-confirm-danger" onClick={state.confirmClear} type="button">
              {t('common:settings.models.clearConfirmAccept')}
            </button>
          </div>
        </div>
      ) : null}
    </form>
  )
}
