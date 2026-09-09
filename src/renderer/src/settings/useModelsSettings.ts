import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  normalizeModelsBaseUrl,
  type CredentialUpdate,
  type ModelConfigId,
  type ModelConfigSummary,
  type ModelsConfigList,
  type ModelsErrorCode,
  type ModelsErrorField,
  type TestModelsConnectionResult
} from '../../../shared/models'

export interface ModelsDraft {
  baseUrl: string
  modelId: string
  // 密码框中本次输入的新密钥；只作为临时草稿单向提交，成功后清空，永不回填。
  apiKey: string
  removeStoredKey: boolean
}

export type ModelsLoadState = 'loading' | 'ready' | 'error'

// 同一时间只编辑一条配置：closed 无表单；create 空表单；edit 定位到某条记录。
export type EditSession =
  { mode: 'closed' } | { mode: 'create' } | { mode: 'edit'; configId: ModelConfigId }

export type ModelsSaveState =
  { kind: 'idle' } | { kind: 'saving' } | { kind: 'failed'; code: ModelsErrorCode }

export type ModelsTestOutcome =
  | { status: 'idle' }
  | { status: 'running'; requestId: string }
  | { status: 'succeeded' }
  | { status: 'cancelled' }
  | { status: 'failed'; code: ModelsErrorCode }

export type ModelsDeleteState =
  { kind: 'idle' } | { kind: 'deleting' } | { kind: 'failed'; code: ModelsErrorCode }

// 行测试结果弹窗：打开后随测试进度更新 outcome；关闭时测试仍在途则先取消。
export type RowTestDialog = { configId: ModelConfigId; outcome: ModelsTestOutcome }

export type ModelsSetActiveState =
  { kind: 'idle' } | { kind: 'saving' } | { kind: 'failed'; code: ModelsErrorCode }

// 弃改确认携带待执行意图：确认放弃后继续该意图（新建 / 切换编辑 / 关闭表单）。
export type DiscardIntent =
  { kind: 'create' } | { kind: 'edit'; configId: ModelConfigId } | { kind: 'close' }

export type ModelsFieldIssues = Partial<Record<ModelsErrorField, ModelsErrorCode>>

export type ModelsDraftField = 'baseUrl' | 'modelId' | 'apiKey' | 'removeStoredKey'

// 活动测试标识：行测试与草稿测试共享每窗口一个限额；回调按此标识归属结果，
// 取消或开启新测试后迟到回调不再覆盖状态。
export type ActiveTest =
  { kind: 'row'; configId: ModelConfigId; requestId: string } | { kind: 'draft'; requestId: string }

const EMPTY_DRAFT: ModelsDraft = { baseUrl: '', modelId: '', apiKey: '', removeStoredKey: false }

function draftFromSummary(summary: ModelConfigSummary): ModelsDraft {
  return { baseUrl: summary.baseUrl, modelId: summary.modelId, apiKey: '', removeStoredKey: false }
}

// 凭据意图由明确操作表达：勾选移除 → remove；输入了新密钥 → replace；否则 keep。
function credentialIntentFromDraft(
  draft: ModelsDraft,
  target: ModelConfigSummary | undefined
): CredentialUpdate {
  if (
    target !== undefined &&
    (target.hasApiKey || target.apiKeyUndecryptable) &&
    draft.removeStoredKey
  ) {
    return { action: 'remove' }
  }
  if (draft.apiKey.trim().length > 0) {
    return { action: 'replace', apiKey: draft.apiKey.trim() }
  }
  return { action: 'keep' }
}

// 与 Shared/Core 相同规则的本地校验：让字段错误在提交前即时呈现。
function validateDraft(draft: ModelsDraft): ModelsFieldIssues {
  const issues: ModelsFieldIssues = {}
  if (!normalizeModelsBaseUrl(draft.baseUrl).ok) {
    issues.baseUrl = 'INVALID_BASE_URL'
  }
  if (draft.modelId.trim().length === 0) {
    issues.modelId = 'INVALID_MODEL_ID'
  }
  return issues
}

function serverFieldIssues(error: {
  code: ModelsErrorCode
  field?: ModelsErrorField
}): ModelsFieldIssues {
  return error.field !== undefined ? { [error.field]: error.code } : {}
}

// 提交前与 Shared 相同规则规范化 Base URL（validateDraft 已保证可通过）。
function submitBaseUrl(draft: ModelsDraft): string {
  const normalized = normalizeModelsBaseUrl(draft.baseUrl)
  return normalized.ok ? normalized.url : draft.baseUrl.trim()
}

function testOutcomeFromResult(result: TestModelsConnectionResult): ModelsTestOutcome {
  if (result.status === 'ok') return { status: 'succeeded' }
  if (result.error.code === 'TEST_CANCELLED') return { status: 'cancelled' }
  return { status: 'failed', code: result.error.code }
}

// 页面级模型设置状态：SettingsPage 持有并下发给 ModelsSettings 区块，
// 区块随菜单切换卸载时编辑草稿与测试结果不丢失。
export interface ModelsSettingsState {
  loadState: ModelsLoadState
  retryLoad: () => void
  list: ModelsConfigList | undefined
  editSession: EditSession
  editTarget: ModelConfigSummary | undefined
  draft: ModelsDraft
  fieldIssues: ModelsFieldIssues
  saveState: ModelsSaveState
  dirty: boolean
  formLocked: boolean
  deleteTarget: ModelConfigSummary | undefined
  deleteState: ModelsDeleteState
  setActiveState: ModelsSetActiveState
  rowTestDialog: RowTestDialog | undefined
  draftTest: ModelsTestOutcome
  activeTest: ActiveTest | undefined
  discardPrompt: DiscardIntent | undefined
  beginCreate: () => void
  beginEdit: (configId: ModelConfigId) => void
  requestCloseForm: () => void
  confirmDiscard: () => void
  keepEditing: () => void
  setDraftField: (field: ModelsDraftField, value: string | boolean) => void
  saveEdit: () => void
  requestDelete: (configId: ModelConfigId) => void
  cancelDelete: () => void
  confirmDelete: () => void
  setActive: (configId: ModelConfigId) => void
  testRow: (configId: ModelConfigId) => void
  closeRowTestDialog: () => void
  testDraft: () => void
  cancelActiveTest: () => void
  // Escape 分层处理：优先关闭本区块确认层或编辑表单；返回 false 表示未消费。
  consumeEscape: () => boolean
}

export function useModelsSettings(): ModelsSettingsState {
  const [loadState, setLoadState] = useState<ModelsLoadState>('loading')
  const [list, setList] = useState<ModelsConfigList | undefined>(undefined)
  const [editSession, setEditSession] = useState<EditSession>({ mode: 'closed' })
  const [draft, setDraft] = useState<ModelsDraft>(EMPTY_DRAFT)
  const [fieldIssues, setFieldIssues] = useState<ModelsFieldIssues>({})
  const [saveState, setSaveState] = useState<ModelsSaveState>({ kind: 'idle' })
  const [deleteTarget, setDeleteTarget] = useState<ModelConfigSummary | undefined>(undefined)
  const [deleteState, setDeleteState] = useState<ModelsDeleteState>({ kind: 'idle' })
  const [activeSelectionState, setActiveState] = useState<ModelsSetActiveState>({ kind: 'idle' })
  const [rowTestDialog, setRowTestDialog] = useState<RowTestDialog | undefined>(undefined)
  const [draftTest, setDraftTest] = useState<ModelsTestOutcome>({ status: 'idle' })
  const [activeTest, setActiveTest] = useState<ActiveTest | undefined>(undefined)
  const [discardPrompt, setDiscardPrompt] = useState<DiscardIntent | undefined>(undefined)
  // 仅在事件回调与异步结果中读写的 ref：活动测试标识、最新列表与写串行标记。
  const activeTestRef = useRef<ActiveTest | undefined>(undefined)
  const listRef = useRef<ModelsConfigList | undefined>(undefined)
  const writeInFlightRef = useRef(false)

  // 读取只包含异步状态更新：effect 直接调用不会在渲染提交阶段同步 setState。
  const loadList = useCallback((): void => {
    window.api.models
      .listConfigs()
      .then((result) => {
        if (result.status === 'ok') {
          setList(result.list)
          listRef.current = result.list
          setEditSession({ mode: 'closed' })
          setDraft(EMPTY_DRAFT)
          setFieldIssues({})
          setSaveState({ kind: 'idle' })
          setDeleteTarget(undefined)
          setDeleteState({ kind: 'idle' })
          setActiveState({ kind: 'idle' })
          setRowTestDialog(undefined)
          setDraftTest({ status: 'idle' })
          setDiscardPrompt(undefined)
          setLoadState('ready')
        } else {
          setLoadState('error')
        }
      })
      .catch(() => setLoadState('error'))
  }, [])

  useEffect(() => {
    loadList()
  }, [loadList])

  // 重试由用户事件触发：先回到 loading 再发起读取。
  const retryLoad = useCallback((): void => {
    setLoadState('loading')
    loadList()
  }, [loadList])

  const editTarget = useMemo(
    () =>
      editSession.mode === 'edit'
        ? list?.configs.find((config) => config.id === editSession.configId)
        : undefined,
    [editSession, list]
  )

  const busy =
    saveState.kind === 'saving' ||
    deleteState.kind === 'deleting' ||
    activeSelectionState.kind === 'saving' ||
    activeTest !== undefined

  const formLocked = saveState.kind === 'saving' || draftTest.status === 'running'

  const dirty = useMemo(() => {
    if (editSession.mode === 'closed') return false
    if (editSession.mode === 'create') {
      return (
        draft.baseUrl.trim() !== '' ||
        draft.modelId.trim() !== '' ||
        draft.apiKey !== '' ||
        draft.removeStoredKey
      )
    }
    const target = editTarget
    if (target === undefined) return draft !== EMPTY_DRAFT
    return (
      draft.baseUrl !== target.baseUrl ||
      draft.modelId !== target.modelId ||
      draft.apiKey !== '' ||
      draft.removeStoredKey
    )
  }, [draft, editSession, editTarget])

  const openCreateForm = useCallback((): void => {
    setEditSession({ mode: 'create' })
    setDraft(EMPTY_DRAFT)
    setFieldIssues({})
    setSaveState({ kind: 'idle' })
    setDraftTest({ status: 'idle' })
  }, [])

  const openEditForm = useCallback((configId: ModelConfigId): void => {
    const target = listRef.current?.configs.find((config) => config.id === configId)
    if (target === undefined) return
    setEditSession({ mode: 'edit', configId })
    setDraft(draftFromSummary(target))
    setFieldIssues({})
    setSaveState({ kind: 'idle' })
    setDraftTest({ status: 'idle' })
  }, [])

  const closeForm = useCallback((): void => {
    setEditSession({ mode: 'closed' })
    setDraft(EMPTY_DRAFT)
    setFieldIssues({})
    setSaveState({ kind: 'idle' })
    setDraftTest({ status: 'idle' })
  }, [])

  // 未保存修改时新建、切换编辑目标、取消表单先确认是否放弃。
  const beginCreate = useCallback((): void => {
    if (busy) return
    if (editSession.mode !== 'closed' && dirty) {
      setDiscardPrompt({ kind: 'create' })
      return
    }
    openCreateForm()
  }, [busy, dirty, editSession, openCreateForm])

  const beginEdit = useCallback(
    (configId: ModelConfigId): void => {
      if (busy) return
      if (editSession.mode !== 'closed' && dirty) {
        setDiscardPrompt({ kind: 'edit', configId })
        return
      }
      openEditForm(configId)
    },
    [busy, dirty, editSession, openEditForm]
  )

  const requestCloseForm = useCallback((): void => {
    if (editSession.mode === 'closed') return
    if (dirty) {
      setDiscardPrompt({ kind: 'close' })
      return
    }
    closeForm()
  }, [closeForm, dirty, editSession])

  const confirmDiscard = useCallback((): void => {
    const intent = discardPrompt
    setDiscardPrompt(undefined)
    if (intent === undefined) return
    if (intent.kind === 'create') openCreateForm()
    else if (intent.kind === 'edit') openEditForm(intent.configId)
    else closeForm()
  }, [closeForm, discardPrompt, openCreateForm, openEditForm])

  const keepEditing = useCallback((): void => {
    setDiscardPrompt(undefined)
  }, [])

  // 表单修改期间输入被 UI 禁止（保存中/测试中），这里不做额外防御。
  const setDraftField = useCallback((field: ModelsDraftField, value: string | boolean) => {
    setDraft((current) => ({ ...current, [field]: value }))
    // 任何表单修改都清除旧草稿测试结果与保存状态；字段错误随修改重估。
    setDraftTest({ status: 'idle' })
    setSaveState((current) => (current.kind === 'failed' ? { kind: 'idle' } : current))
    setFieldIssues((current) => {
      if (field === 'baseUrl' || field === 'modelId' || field === 'apiKey') {
        const next = { ...current }
        delete next[field]
        return next
      }
      return current
    })
  }, [])

  const saveEdit = useCallback((): void => {
    if (formLocked || writeInFlightRef.current) return
    const session = editSession
    if (session.mode === 'closed') return
    const issues = validateDraft(draft)
    if (Object.keys(issues).length > 0) {
      setFieldIssues((current) => ({ ...current, ...issues }))
      return
    }
    const payload = {
      protocol: 'openai-compatible' as const,
      baseUrl: submitBaseUrl(draft),
      modelId: draft.modelId.trim(),
      credential: credentialIntentFromDraft(draft, editTarget)
    }
    setSaveState({ kind: 'saving' })
    writeInFlightRef.current = true
    const request =
      session.mode === 'create'
        ? window.api.models.createConfig(payload)
        : window.api.models.updateConfig({ configId: session.configId, ...payload })
    request
      .then((result) => {
        if (result.status === 'ok') {
          // 以 Main 返回的完整安全列表刷新，避免并发响应互相覆盖。
          setList(result.list)
          listRef.current = result.list
          if (session.mode === 'edit') {
            // 编辑保存后旧配置的测试结果失效，关闭仍指向它的结果弹窗。
            setRowTestDialog((current) =>
              current?.configId === session.configId ? undefined : current
            )
          }
          closeForm()
          return
        }
        const fieldError = serverFieldIssues(result.error)
        if (Object.keys(fieldError).length > 0) {
          setFieldIssues((current) => ({ ...current, ...fieldError }))
          setSaveState({ kind: 'idle' })
        } else {
          setSaveState({ kind: 'failed', code: result.error.code })
        }
      })
      .catch(() => setSaveState({ kind: 'failed', code: 'UNKNOWN_ERROR' }))
      .finally(() => {
        writeInFlightRef.current = false
      })
  }, [closeForm, draft, editSession, editTarget, formLocked])

  const requestDelete = useCallback(
    (configId: ModelConfigId): void => {
      if (busy) return
      const target = listRef.current?.configs.find((config) => config.id === configId)
      if (target === undefined) return
      setDeleteTarget(target)
      setDeleteState({ kind: 'idle' })
    },
    [busy]
  )

  const cancelDelete = useCallback((): void => {
    if (deleteState.kind === 'deleting') return
    setDeleteTarget(undefined)
    setDeleteState({ kind: 'idle' })
  }, [deleteState.kind])

  const confirmDelete = useCallback((): void => {
    const target = deleteTarget
    if (target === undefined || writeInFlightRef.current) return
    setDeleteState({ kind: 'deleting' })
    writeInFlightRef.current = true
    window.api.models
      .deleteConfig({ configId: target.id })
      .then((result) => {
        if (result.status === 'ok') {
          setList(result.list)
          listRef.current = result.list
          // 被删除配置的测试结果弹窗一并关闭。
          setRowTestDialog((current) => (current?.configId === target.id ? undefined : current))
          // 被删除目标是当前编辑对象时，对应草稿一并清理。
          if (editSession.mode === 'edit' && editSession.configId === target.id) {
            closeForm()
          }
          setDeleteTarget(undefined)
          setDeleteState({ kind: 'idle' })
        } else {
          setDeleteState({ kind: 'failed', code: result.error.code })
        }
      })
      .catch(() => setDeleteState({ kind: 'failed', code: 'UNKNOWN_ERROR' }))
      .finally(() => {
        writeInFlightRef.current = false
      })
  }, [closeForm, deleteTarget, editSession])

  // 当前模型选择与集合一起原子保存；失败不发布新状态，仅提示重试。
  const setActive = useCallback((configId: ModelConfigId): void => {
    if (configId === listRef.current?.activeConfigId || writeInFlightRef.current) return
    setActiveState({ kind: 'saving' })
    writeInFlightRef.current = true
    window.api.models
      .setActiveConfig({ configId })
      .then((result) => {
        if (result.status === 'ok') {
          setList(result.list)
          listRef.current = result.list
          setActiveState({ kind: 'idle' })
        } else {
          setActiveState({ kind: 'failed', code: result.error.code })
        }
      })
      .catch(() => setActiveState({ kind: 'failed', code: 'UNKNOWN_ERROR' }))
      .finally(() => {
        writeInFlightRef.current = false
      })
  }, [])

  // 结果按配置 ID 与 requestId 关联：仅当该测试仍是活动测试且记录仍存在时
  // 才落地；取消后开启的新测试不会被迟到回调覆盖。
  const applyRowTestResult = useCallback(
    (configId: ModelConfigId, requestId: string, result: TestModelsConnectionResult): void => {
      const current = activeTestRef.current
      if (current === undefined || current.kind !== 'row' || current.requestId !== requestId) {
        return
      }
      if (!listRef.current?.configs.some((config) => config.id === configId)) return
      // 弹窗已被用户关闭时不重新打开，仅释放测试锁。
      setRowTestDialog((dialog) =>
        dialog?.configId === configId
          ? { configId, outcome: testOutcomeFromResult(result) }
          : dialog
      )
      activeTestRef.current = undefined
      setActiveTest(undefined)
    },
    []
  )

  const testRow = useCallback(
    (configId: ModelConfigId): void => {
      if (activeTestRef.current !== undefined) return
      if (!listRef.current?.configs.some((config) => config.id === configId)) return
      const requestId = crypto.randomUUID()
      const test: ActiveTest = { kind: 'row', configId, requestId }
      activeTestRef.current = test
      setActiveTest(test)
      setRowTestDialog({ configId, outcome: { status: 'running', requestId } })
      window.api.models
        .testSavedConnection({ configId, requestId })
        .then((result) => applyRowTestResult(configId, requestId, result))
        .catch(() => {
          applyRowTestResult(configId, requestId, {
            status: 'error',
            error: { code: 'UNKNOWN_ERROR' }
          })
        })
    },
    [applyRowTestResult]
  )

  // 测试草稿验证当前输入，结果仅属于编辑表单，不覆盖行测试结果，不自动保存。
  const testDraft = useCallback((): void => {
    if (activeTestRef.current !== undefined || formLocked) return
    const session = editSession
    if (session.mode === 'closed') return
    const issues = validateDraft(draft)
    if (Object.keys(issues).length > 0) {
      setFieldIssues((current) => ({ ...current, ...issues }))
      return
    }
    const requestId = crypto.randomUUID()
    const test: ActiveTest = { kind: 'draft', requestId }
    activeTestRef.current = test
    setActiveTest(test)
    setDraftTest({ status: 'running', requestId })
    window.api.models
      .testDraftConnection({
        requestId,
        protocol: 'openai-compatible',
        baseUrl: submitBaseUrl(draft),
        modelId: draft.modelId.trim(),
        credential: credentialIntentFromDraft(draft, editTarget),
        ...(session.mode === 'edit' ? { editTargetConfigId: session.configId } : {})
      })
      .then((result) => {
        const current = activeTestRef.current
        if (current === undefined || current.kind !== 'draft' || current.requestId !== requestId) {
          return
        }
        if (result.status === 'error') {
          const fieldError = serverFieldIssues(result.error)
          if (Object.keys(fieldError).length > 0) {
            setFieldIssues((currentIssues) => ({ ...currentIssues, ...fieldError }))
            setDraftTest({ status: 'idle' })
            activeTestRef.current = undefined
            setActiveTest(undefined)
            return
          }
        }
        setDraftTest(testOutcomeFromResult(result))
        activeTestRef.current = undefined
        setActiveTest(undefined)
      })
      .catch(() => {
        const current = activeTestRef.current
        if (current === undefined || current.kind !== 'draft' || current.requestId !== requestId) {
          return
        }
        setDraftTest({ status: 'failed', code: 'UNKNOWN_ERROR' })
        activeTestRef.current = undefined
        setActiveTest(undefined)
      })
  }, [draft, editSession, editTarget, formLocked])

  // 切离 Models、退出 Settings 时中止在途测试；编辑草稿保留，取消结果落地后
  // 展示“已取消”，允许再次测试。
  const cancelActiveTest = useCallback((): void => {
    const test = activeTestRef.current
    if (test === undefined) return
    void window.api.models.cancelTest({ requestId: test.requestId }).catch(() => {
      // 取消失败时等待测试自然结束（15s 截止），不打断页面切换。
    })
  }, [])

  // 关闭行测试结果弹窗；测试仍在途时先请求取消，结果落地后释放测试锁。
  const closeRowTestDialog = useCallback((): void => {
    if (rowTestDialog === undefined) return
    if (rowTestDialog.outcome.status === 'running') {
      cancelActiveTest()
    }
    setRowTestDialog(undefined)
  }, [cancelActiveTest, rowTestDialog])

  // 页面卸载（退出 Settings）时清理在途测试；Main 侧 sender 销毁同样会中止。
  useEffect(() => cancelActiveTest, [cancelActiveTest])

  // Escape 分层：先关确认层（删除确认、弃改确认），再关测试结果弹窗，最后处理
  // 编辑表单；一次按键只执行一个动作，避免同时触发多个层级。
  const consumeEscape = useCallback((): boolean => {
    if (deleteTarget !== undefined) {
      cancelDelete()
      return true
    }
    if (discardPrompt !== undefined) {
      keepEditing()
      return true
    }
    if (rowTestDialog !== undefined) {
      closeRowTestDialog()
      return true
    }
    if (editSession.mode !== 'closed') {
      requestCloseForm()
      return true
    }
    return false
  }, [
    cancelDelete,
    closeRowTestDialog,
    deleteTarget,
    discardPrompt,
    editSession,
    keepEditing,
    requestCloseForm,
    rowTestDialog
  ])

  return {
    loadState,
    retryLoad,
    list,
    editSession,
    editTarget,
    draft,
    fieldIssues,
    saveState,
    dirty,
    formLocked,
    deleteTarget,
    deleteState,
    setActiveState: activeSelectionState,
    rowTestDialog,
    draftTest,
    activeTest,
    discardPrompt,
    beginCreate,
    beginEdit,
    requestCloseForm,
    confirmDiscard,
    keepEditing,
    setDraftField,
    saveEdit,
    requestDelete,
    cancelDelete,
    confirmDelete,
    setActive,
    testRow,
    closeRowTestDialog,
    testDraft,
    cancelActiveTest,
    consumeEscape
  }
}
