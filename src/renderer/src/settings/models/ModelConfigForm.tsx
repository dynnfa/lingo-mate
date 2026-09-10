import { useTranslation } from 'react-i18next'
import { modelsErrorKey, modelsTestOutcomeKey } from './models-messages'
import type { ModelsSettingsState } from './useModelsSettings'

// 新增／编辑复用的配置表单：编辑按配置 ID 加载非敏感字段，密码框始终为空。
// 留空保留该条记录的密钥，新输入替换，勾选移除才删除；新增时空输入表示无密钥。
export function ModelConfigForm({ state }: { state: ModelsSettingsState }): React.JSX.Element {
  const { t } = useTranslation(['common', 'errors'])
  const { draft, editSession, editTarget, fieldIssues, formLocked, saveState, draftTest } = state
  const editing = editSession.mode === 'edit'
  const hasStoredKey =
    editTarget !== undefined && (editTarget.hasApiKey || editTarget.apiKeyUndecryptable)

  const saveMessage = (() => {
    if (saveState.kind === 'saving') return t('common:settings.models.saving')
    if (saveState.kind === 'failed') return t(modelsErrorKey(saveState.code))
    return undefined
  })()
  const testMessageKey = modelsTestOutcomeKey(draftTest)
  const testMessage = testMessageKey !== undefined ? t(testMessageKey) : undefined

  return (
    <form
      aria-labelledby="models-form-title"
      className="models-form"
      noValidate
      onSubmit={(event) => {
        event.preventDefault()
        state.saveEdit()
      }}
    >
      <h3 className="models-form-title" id="models-form-title">
        {editing
          ? t('common:settings.models.formTitleEdit')
          : t('common:settings.models.formTitleCreate')}
      </h3>

      <fieldset className="models-fieldset" disabled={formLocked}>
        <div className="models-field">
          <label htmlFor="models-protocol">{t('common:settings.models.protocolLabel')}</label>
          <select
            id="models-protocol"
            value={draft.protocol}
            onChange={(event) => state.setDraftField('protocol', event.target.value)}
          >
            <option value="openai-compatible">
              {t('common:settings.models.protocolOpenAICompatible')}
            </option>
            <option value="gemini">{t('common:settings.models.protocolGemini')}</option>
          </select>
        </div>

        <div className="models-field">
          <label htmlFor="models-base-url">{t('common:settings.models.baseUrlLabel')}</label>
          <input
            aria-describedby={fieldIssues.baseUrl ? 'models-base-url-error' : undefined}
            aria-invalid={fieldIssues.baseUrl !== undefined}
            autoComplete="off"
            id="models-base-url"
            onChange={(event) => state.setDraftField('baseUrl', event.target.value)}
            placeholder={t(
              draft.protocol === 'gemini'
                ? 'common:settings.models.geminiBaseUrlPlaceholder'
                : 'common:settings.models.baseUrlPlaceholder'
            )}
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
            {editing && editTarget?.hasApiKey === true
              ? t('common:settings.models.apiKeyKeepHint')
              : t('common:settings.models.apiKeyOptionalHint')}
          </p>
          {fieldIssues.apiKey ? (
            <p className="models-field-error" id="models-api-key-error">
              {t(modelsErrorKey(fieldIssues.apiKey))}
            </p>
          ) : null}
        </div>

        {editing && editTarget ? (
          <div className="models-key-status">
            <span className="models-key-status-label">
              {t('common:settings.models.apiKeyStatusLabel')}
            </span>
            {editTarget.apiKeyUndecryptable ? (
              <span className="models-key-warning">
                {t('common:settings.models.apiKeyUnavailable')}
              </span>
            ) : editTarget.hasApiKey ? (
              <span className="models-key-configured">
                {t('common:settings.models.apiKeyConfigured')}
              </span>
            ) : (
              <span className="models-key-missing">
                {t('common:settings.models.apiKeyNotConfigured')}
              </span>
            )}
            {hasStoredKey ? (
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
          <button disabled={formLocked} onClick={state.testDraft} type="button">
            {t('common:settings.models.testDraftButton')}
          </button>
          <button disabled={formLocked || !state.dirty} type="submit">
            {t('common:settings.models.saveButton')}
          </button>
          <button disabled={formLocked} onClick={state.requestCloseForm} type="button">
            {t('common:settings.models.cancelButton')}
          </button>
        </div>

        <p className="models-test-hint">{t('common:settings.models.testHint')}</p>

        <div aria-live="polite" className="models-status" role="status">
          {saveMessage ? <p>{saveMessage}</p> : null}
          {testMessage ? <p>{testMessage}</p> : null}
        </div>
      </fieldset>
    </form>
  )
}
