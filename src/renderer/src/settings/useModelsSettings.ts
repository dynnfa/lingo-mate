import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  normalizeModelsBaseUrl,
  type CredentialUpdate,
  type ModelsErrorCode,
  type ModelsErrorField,
  type ModelsSettingsSummary
} from '../../../shared/models'

export interface ModelsDraft {
  baseUrl: string
  modelId: string
  // 密码框中本次输入的新密钥；只作为临时草稿单向提交，成功后清空，永不回填。
  apiKey: string
  removeStoredKey: boolean
}

export type ModelsLoadState = 'loading' | 'ready' | 'error'

export type ModelsSaveState =
  | { kind: 'idle' }
  | { kind: 'saving' }
  | { kind: 'saved' }
  | { kind: 'failed'; code: ModelsErrorCode }

export type ModelsTestOutcome =
  | { status: 'idle' }
  | { status: 'running'; requestId: string }
  | { status: 'succeeded' }
  | { status: 'failed'; code: ModelsErrorCode }

export type ModelsClearState =
  | { kind: 'idle' }
  | { kind: 'confirming' }
  | { kind: 'clearing' }
  | { kind: 'failed'; code: ModelsErrorCode }

export type ModelsFieldIssues = Partial<Record<ModelsErrorField, ModelsErrorCode>>

export type ModelsDraftField = 'baseUrl' | 'modelId' | 'apiKey' | 'removeStoredKey'

const EMPTY_DRAFT: ModelsDraft = { baseUrl: '', modelId: '', apiKey: '', removeStoredKey: false }

function draftFromSummary(summary: ModelsSettingsSummary): ModelsDraft {
  if (!summary.configured) return EMPTY_DRAFT
  return {
    baseUrl: summary.baseUrl,
    modelId: summary.modelId,
    apiKey: '',
    removeStoredKey: false
  }
}

// 凭据意图由明确操作表达：勾选移除 → remove；输入了新密钥 → replace；否则 keep。
export function credentialIntentFromDraft(
  draft: ModelsDraft,
  summary: ModelsSettingsSummary | undefined
): CredentialUpdate {
  if (
    summary?.configured === true &&
    (summary.hasApiKey || summary.apiKeyUndecryptable) &&
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

// 页面级模型设置状态：SettingsPage 持有并下发给 ModelsSettings 区块，
// 区块随菜单切换卸载时草稿与结果不丢失。
export interface ModelsSettingsState {
  loadState: ModelsLoadState
  retryLoad: () => void
  summary: ModelsSettingsSummary | undefined
  draft: ModelsDraft
  fieldIssues: ModelsFieldIssues
  saveState: ModelsSaveState
  testOutcome: ModelsTestOutcome
  clearState: ModelsClearState
  busy: boolean
  dirty: boolean
  setDraftField: (field: ModelsDraftField, value: string | boolean) => void
  save: () => void
  test: () => void
  cancelActiveTest: () => void
  requestClear: () => void
  cancelClear: () => void
  confirmClear: () => void
}

export function useModelsSettings(): ModelsSettingsState {
  const [loadState, setLoadState] = useState<ModelsLoadState>('loading')
  const [summary, setSummary] = useState<ModelsSettingsSummary | undefined>(undefined)
  const [draft, setDraft] = useState<ModelsDraft>(EMPTY_DRAFT)
  const [fieldIssues, setFieldIssues] = useState<ModelsFieldIssues>({})
  const [saveState, setSaveState] = useState<ModelsSaveState>({ kind: 'idle' })
  const [testOutcome, setTestOutcome] = useState<ModelsTestOutcome>({ status: 'idle' })
  const [clearState, setClearState] = useState<ModelsClearState>({ kind: 'idle' })
  const activeTestRef = useRef<string | undefined>(undefined)

  // 读取只包含异步状态更新：effect 直接调用不会在渲染提交阶段同步 setState。
  const loadSummary = useCallback((): void => {
    window.api.models
      .getSettings()
      .then((result) => {
        if (result.status === 'ok') {
          setSummary(result.summary)
          setDraft(draftFromSummary(result.summary))
          setFieldIssues({})
          setSaveState({ kind: 'idle' })
          setTestOutcome({ status: 'idle' })
          setClearState({ kind: 'idle' })
          setLoadState('ready')
        } else {
          setLoadState('error')
        }
      })
      .catch(() => setLoadState('error'))
  }, [])

  useEffect(() => {
    loadSummary()
  }, [loadSummary])

  // 重试由用户事件触发：先回到 loading 再发起读取。
  const retryLoad = useCallback((): void => {
    setLoadState('loading')
    loadSummary()
  }, [loadSummary])

  // 测试进行中（running）期间修改草稿被 UI 禁止，这里不做额外防御。
  const busy =
    saveState.kind === 'saving' ||
    testOutcome.status === 'running' ||
    clearState.kind === 'clearing'

  const dirty = useMemo(() => {
    if (loadState !== 'ready' || summary === undefined) return false
    const savedBaseUrl = summary.configured ? summary.baseUrl : ''
    const savedModelId = summary.configured ? summary.modelId : ''
    return (
      draft.baseUrl !== savedBaseUrl ||
      draft.modelId !== savedModelId ||
      draft.apiKey !== '' ||
      (summary.configured === true &&
        (summary.hasApiKey || summary.apiKeyUndecryptable) &&
        draft.removeStoredKey)
    )
  }, [draft, loadState, summary])

  const setDraftField = useCallback((field: ModelsDraftField, value: string | boolean) => {
    setDraft((current) => ({ ...current, [field]: value }))
    // 任何表单修改都清除旧测试结果与保存状态；对应字段错误随修改重估。
    setTestOutcome({ status: 'idle' })
    setSaveState((current) =>
      current.kind === 'saved' || current.kind === 'failed' ? { kind: 'idle' } : current
    )
    setFieldIssues((current) => {
      if (field === 'baseUrl' || field === 'modelId' || field === 'apiKey') {
        const next = { ...current }
        delete next[field]
        return next
      }
      return current
    })
  }, [])

  const save = useCallback(() => {
    if (busy) return
    const issues = validateDraft(draft)
    if (Object.keys(issues).length > 0) {
      setFieldIssues((current) => ({ ...current, ...issues }))
      return
    }
    setSaveState({ kind: 'saving' })
    window.api.models
      .saveSettings({
        protocol: 'openai-compatible',
        baseUrl: submitBaseUrl(draft),
        modelId: draft.modelId.trim(),
        credential: credentialIntentFromDraft(draft, summary)
      })
      .then((result) => {
        if (result.status === 'ok') {
          setSummary(result.summary)
          setDraft(draftFromSummary(result.summary))
          setFieldIssues({})
          setSaveState({ kind: 'saved' })
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
  }, [busy, draft, summary])

  // 测试连接使用当前草稿，不自动保存；requestId 用于取消关联。
  const test = useCallback(() => {
    if (busy) return
    const issues = validateDraft(draft)
    if (Object.keys(issues).length > 0) {
      setFieldIssues((current) => ({ ...current, ...issues }))
      return
    }
    const requestId = crypto.randomUUID()
    activeTestRef.current = requestId
    setTestOutcome({ status: 'running', requestId })
    window.api.models
      .testConnection({
        requestId,
        protocol: 'openai-compatible',
        baseUrl: submitBaseUrl(draft),
        modelId: draft.modelId.trim(),
        credential: credentialIntentFromDraft(draft, summary)
      })
      .then((result) => {
        if (result.status === 'ok') {
          setTestOutcome({ status: 'succeeded' })
        } else {
          const fieldError = serverFieldIssues(result.error)
          if (Object.keys(fieldError).length > 0) {
            setFieldIssues((current) => ({ ...current, ...fieldError }))
            setTestOutcome({ status: 'idle' })
          } else {
            setTestOutcome({ status: 'failed', code: result.error.code })
          }
        }
      })
      .catch(() => setTestOutcome({ status: 'failed', code: 'UNKNOWN_ERROR' }))
      .finally(() => {
        if (activeTestRef.current === requestId) activeTestRef.current = undefined
      })
  }, [busy, draft, summary])

  // 切离 Models、退出 Settings 时中止在途测试；表单草稿保留。
  const cancelActiveTest = useCallback(() => {
    const requestId = activeTestRef.current
    if (requestId === undefined) return
    void window.api.models.cancelTest({ requestId }).catch(() => {
      // 取消失败时等待测试自然结束（15s 截止），不打断页面切换。
    })
  }, [])

  // 页面卸载（退出 Settings）时清理在途测试；Main 侧 sender 销毁同样会中止。
  useEffect(() => cancelActiveTest, [cancelActiveTest])

  const requestClear = useCallback(() => {
    if (busy) return
    setClearState({ kind: 'confirming' })
  }, [busy])

  const cancelClear = useCallback(() => {
    setClearState({ kind: 'idle' })
  }, [])

  const confirmClear = useCallback(() => {
    if (busy) return
    setClearState({ kind: 'clearing' })
    window.api.models
      .clearSettings()
      .then((result) => {
        if (result.status === 'ok') {
          setSummary(result.summary)
          setDraft(EMPTY_DRAFT)
          setFieldIssues({})
          setSaveState({ kind: 'idle' })
          setTestOutcome({ status: 'idle' })
          setClearState({ kind: 'idle' })
        } else {
          setClearState({ kind: 'failed', code: result.error.code })
        }
      })
      .catch(() => setClearState({ kind: 'failed', code: 'UNKNOWN_ERROR' }))
  }, [busy])

  return {
    loadState,
    retryLoad,
    summary,
    draft,
    fieldIssues,
    saveState,
    testOutcome,
    clearState,
    busy,
    dirty,
    setDraftField,
    save,
    test,
    cancelActiveTest,
    requestClear,
    cancelClear,
    confirmClear
  }
}
