import { useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { ModelConfigForm } from './ModelConfigForm'
import { ModelsTable } from './ModelsTable'
import { modelsDeleteErrorKey, modelsSetActiveErrorKey } from './models-messages'
import type { ModelsSettingsState } from './useModelsSettings'

// 设置页“模型”区块：表格化管理已保存的 LLM 配置。表格只展示已保存记录，
// 新增／编辑在表格下方展开复用表单；删除与弃改均需确认。状态本体由
// SettingsPage 通过 useModelsSettings 持有，区块随菜单切换卸载时草稿不丢失。
export function ModelsSettings({
  state
}: {
  state: ModelsSettingsState
}): React.JSX.Element | null {
  const { t } = useTranslation(['common', 'errors'])
  const { loadState, retryLoad, list, editSession, deleteTarget, discardPrompt } = state
  // 焦点管理：关闭表单后焦点回到来源按钮；删除成功后移至下一行操作按钮，
  // 空列表时移至新增入口。
  const addButtonRef = useRef<HTMLButtonElement>(null)
  const formOpenerRef = useRef<HTMLElement | null>(null)
  const postDeleteFocusRef = useRef<HTMLElement | null>(null)
  const wasFormOpenRef = useRef(false)
  const wasDeletingRef = useRef(false)

  useEffect(() => {
    const formOpen = editSession.mode !== 'closed'
    if (wasFormOpenRef.current && !formOpen) {
      formOpenerRef.current?.focus()
    }
    wasFormOpenRef.current = formOpen
  }, [editSession.mode])

  // 删除完成（deleting → idle）后把焦点移到预记录的目标按钮。
  useEffect(() => {
    const deleting = deleteTarget !== undefined && state.deleteState.kind === 'deleting'
    if (wasDeletingRef.current && !deleting && state.deleteState.kind === 'idle') {
      postDeleteFocusRef.current?.focus()
    }
    wasDeletingRef.current = deleting
  }, [deleteTarget, state.deleteState.kind])

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

  if (list === undefined) return null
  const empty = list.configs.length === 0

  const beginCreateFromButton = (event: React.MouseEvent<HTMLButtonElement>): void => {
    formOpenerRef.current = event.currentTarget
    state.beginCreate()
  }

  const beginEditFromButton = (
    configId: string,
    event: React.MouseEvent<HTMLButtonElement>
  ): void => {
    formOpenerRef.current = event.currentTarget
    state.beginEdit(configId)
  }

  const requestDeleteFromButton = (
    configId: string,
    event: React.MouseEvent<HTMLButtonElement>
  ): void => {
    // 删除成功后的焦点目标：下一行第一个操作按钮，否则新增入口。
    const row = event.currentTarget.closest('tr')
    const nextRow = row?.nextElementSibling
    const nextButton = nextRow?.querySelector<HTMLButtonElement>('.models-table-actions button')
    postDeleteFocusRef.current = nextButton ?? addButtonRef.current
    state.requestDelete(configId)
  }

  return (
    <div className="models-settings">
      <p className="settings-section-description">{t('common:settings.models.description')}</p>

      {empty ? (
        <div className="models-empty">
          <p className="models-empty-title">{t('common:settings.models.emptyTitle')}</p>
          <p className="models-empty-body">{t('common:settings.models.emptyBody')}</p>
        </div>
      ) : (
        <div className="models-current">
          <label className="models-field-label" htmlFor="models-active-config">
            {t('common:settings.models.currentModelLabel')}
          </label>
          <select
            disabled={state.setActiveState.kind === 'saving'}
            id="models-active-config"
            onChange={(event) => state.setActive(event.target.value)}
            value={list.activeConfigId ?? ''}
          >
            {list.activeConfigId === null ? (
              <option value="">{t('common:settings.models.currentModelPlaceholder')}</option>
            ) : null}
            {list.configs.map((config) => (
              <option key={config.id} value={config.id}>
                {`${config.modelId} — ${config.baseUrl}`}
              </option>
            ))}
          </select>
          {list.activeConfigId === null ? (
            <p className="models-current-hint">
              {t('common:settings.models.currentModelRequired')}
            </p>
          ) : null}
          {state.setActiveState.kind === 'failed' ? (
            <p className="settings-error" role="alert">
              {t(modelsSetActiveErrorKey(state.setActiveState.code))}
            </p>
          ) : null}
        </div>
      )}

      <ModelsTable
        activeTest={state.activeTest}
        configs={list.configs}
        deleteState={state.deleteState}
        deletingConfigId={deleteTarget?.id}
        onDelete={requestDeleteFromButton}
        onEdit={beginEditFromButton}
        onTest={state.testRow}
        rowTests={state.rowTests}
      />

      <button
        className="models-add-button"
        disabled={state.formLocked}
        onClick={beginCreateFromButton}
        ref={addButtonRef}
        type="button"
      >
        {t('common:settings.models.addButton')}
      </button>

      {editSession.mode !== 'closed' ? <ModelConfigForm state={state} /> : null}

      {deleteTarget !== undefined ? (
        <div
          aria-describedby="models-delete-confirm-body"
          aria-labelledby="models-delete-confirm-title"
          className="settings-confirm"
          role="dialog"
        >
          <h3 id="models-delete-confirm-title">{t('common:settings.models.deleteConfirmTitle')}</h3>
          <p id="models-delete-confirm-body">
            {t('common:settings.models.deleteConfirmBody', {
              modelId: deleteTarget.modelId,
              baseUrl: deleteTarget.baseUrl
            })}
          </p>
          {list.activeConfigId === deleteTarget.id ? (
            <p>{t('common:settings.models.deleteConfirmActiveNote')}</p>
          ) : null}
          {editSession.mode === 'edit' && editSession.configId === deleteTarget.id ? (
            <p>{t('common:settings.models.deleteConfirmDraftNote')}</p>
          ) : null}
          {state.deleteState.kind === 'failed' ? (
            <p className="settings-error" role="alert">
              {t(modelsDeleteErrorKey(state.deleteState.code))}
            </p>
          ) : null}
          <div className="settings-confirm-actions">
            <button
              disabled={state.deleteState.kind === 'deleting'}
              onClick={state.cancelDelete}
              type="button"
            >
              {t('common:settings.models.deleteConfirmCancel')}
            </button>
            <button
              className="settings-confirm-danger"
              disabled={state.deleteState.kind === 'deleting'}
              onClick={state.confirmDelete}
              type="button"
            >
              {state.deleteState.kind === 'deleting'
                ? t('common:settings.models.deleting')
                : t('common:settings.models.deleteConfirmAccept')}
            </button>
          </div>
        </div>
      ) : null}

      {discardPrompt !== undefined ? (
        <div
          aria-describedby="models-form-discard-confirm-body"
          aria-labelledby="models-form-discard-confirm-title"
          className="settings-confirm"
          role="dialog"
        >
          <h3 id="models-form-discard-confirm-title">
            {t('common:settings.models.discardConfirmTitle')}
          </h3>
          <p id="models-form-discard-confirm-body">
            {t('common:settings.models.discardConfirmBody')}
          </p>
          <div className="settings-confirm-actions">
            <button onClick={state.keepEditing} type="button">
              {t('common:settings.models.discardConfirmKeepEditing')}
            </button>
            <button
              className="settings-confirm-danger"
              onClick={state.confirmDiscard}
              type="button"
            >
              {t('common:settings.models.discardConfirmDiscard')}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  )
}
