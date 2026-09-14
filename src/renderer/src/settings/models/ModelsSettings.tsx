import { useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { ConfirmDialog } from '../../components/ConfirmDialog'
import { StateBlock } from '../../components/StateBlock'
import { ModelConfigForm } from './ModelConfigForm'
import { ModelsTable } from './ModelsTable'
import {
  modelsDeleteErrorKey,
  modelsSetActiveErrorKey,
  modelsTestOutcomeKey
} from './models-messages'
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
  const { loadState, retryLoad, list, editSession, deleteTarget, discardPrompt, rowTestDialog } =
    state
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
    return (
      <StateBlock
        className="models-loading"
        message={t('common:settings.models.loading')}
        variant="loading"
      />
    )
  }

  if (loadState === 'error') {
    return (
      <StateBlock
        className="models-load-error"
        message={t('errors:models.readFailed')}
        onRetry={retryLoad}
        retryLabel={t('common:settings.models.retryLoad')}
        variant="error"
      />
    )
  }

  if (list === undefined) return null
  const empty = list.configs.length === 0

  // 行测试结果弹窗：标明被测配置，状态文案随测试进度在弹窗内更新。
  const rowTestTarget =
    rowTestDialog !== undefined
      ? list.configs.find((config) => config.id === rowTestDialog.configId)
      : undefined
  const rowTestFailed = rowTestDialog?.outcome.status === 'failed'
  const rowTestMessageKey =
    rowTestDialog !== undefined ? modelsTestOutcomeKey(rowTestDialog.outcome) : undefined
  const rowTestMessage = rowTestMessageKey !== undefined ? t(rowTestMessageKey) : undefined

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
        <StateBlock
          className="models-empty"
          message={t('common:settings.models.emptyBody')}
          title={t('common:settings.models.emptyTitle')}
          variant="empty"
        />
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

      <ConfirmDialog
        busy={state.deleteState.kind === 'deleting'}
        cancelLabel={t('common:settings.models.deleteConfirmCancel')}
        confirmLabel={
          state.deleteState.kind === 'deleting'
            ? t('common:settings.models.deleting')
            : t('common:settings.models.deleteConfirmAccept')
        }
        description={
          deleteTarget
            ? t('common:settings.models.deleteConfirmBody', {
                modelId: deleteTarget.modelId,
                baseUrl: deleteTarget.baseUrl
              })
            : undefined
        }
        error={
          state.deleteState.kind === 'failed'
            ? t(modelsDeleteErrorKey(state.deleteState.code))
            : null
        }
        onCancel={state.cancelDelete}
        onConfirm={state.confirmDelete}
        open={deleteTarget !== undefined}
        title={t('common:settings.models.deleteConfirmTitle')}
        tone="danger"
      >
        {list.activeConfigId === deleteTarget?.id ? (
          <p>{t('common:settings.models.deleteConfirmActiveNote')}</p>
        ) : null}
        {editSession.mode === 'edit' && editSession.configId === deleteTarget?.id ? (
          <p>{t('common:settings.models.deleteConfirmDraftNote')}</p>
        ) : null}
      </ConfirmDialog>

      <ConfirmDialog
        cancelLabel={t('common:settings.models.discardConfirmKeepEditing')}
        confirmLabel={t('common:settings.models.discardConfirmDiscard')}
        description={t('common:settings.models.discardConfirmBody')}
        onCancel={state.keepEditing}
        onConfirm={state.confirmDiscard}
        open={discardPrompt !== undefined}
        title={t('common:settings.models.discardConfirmTitle')}
        tone="danger"
      />

      {/* 行测试结果弹窗：标明被测配置，状态文案随测试进度在弹窗内更新。 */}
      <ConfirmDialog
        confirmLabel={
          rowTestDialog?.outcome.status === 'running'
            ? t('common:settings.models.cancelButton')
            : t('common:settings.models.testDialogClose')
        }
        onConfirm={state.closeRowTestDialog}
        onCancel={state.closeRowTestDialog}
        open={rowTestDialog !== undefined}
        title={t('common:settings.models.testDialogTitle')}
      >
        {rowTestTarget !== undefined ? (
          <p>
            {t('common:settings.models.testDialogTarget', {
              modelId: rowTestTarget.modelId,
              baseUrl: rowTestTarget.baseUrl
            })}
          </p>
        ) : null}
        {rowTestMessage !== undefined ? (
          <p
            aria-live="polite"
            className={rowTestFailed ? 'settings-error' : undefined}
            role="status"
          >
            {rowTestMessage}
          </p>
        ) : null}
      </ConfirmDialog>
    </div>
  )
}
