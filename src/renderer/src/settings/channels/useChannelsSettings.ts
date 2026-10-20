import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  ChatChannelBindingView,
  ChatChannelConnectionView,
  ChatChannelPendingBindingRequestView,
  ChatChannelsErrorCode
} from '../../../../shared/chat-channels'

// 聊天平台设置状态：状态读取、连接配置与绑定操作。Token 草稿只在内存，
// 提交后清空；错误以安全错误码保存，由组件翻译。状态刷新遵循 .then()
// 模式：setState 只出现在异步回调中，不在渲染期执行任何不纯调用。

export interface ChannelsStatus {
  connection: ChatChannelConnectionView | null
  binding: ChatChannelBindingView | null
  pendingBindingRequest: ChatChannelPendingBindingRequestView | null
}

export interface IssuedBindingCode {
  code: string
  expiresAt: string
  minutesValid: number
}

export type ChannelsAction =
  | 'configure'
  | 'connect'
  | 'disconnect'
  | 'issueCode'
  | 'confirmBinding'
  | 'rejectBinding'
  | 'unbind'

export interface ChannelsSettingsState {
  loadState: 'loading' | 'error' | 'ready'
  status: ChannelsStatus | undefined
  tokenDraft: string
  bindingCode: IssuedBindingCode | null
  pendingAction: ChannelsAction | null
  actionError: ChatChannelsErrorCode | null
  setTokenDraft(token: string): void
  refresh(): void
  configure(): void
  connect(): void
  disconnect(): void
  issueBindingCode(): void
  confirmBinding(): void
  rejectBinding(): void
  unbind(): void
}

export function useChannelsSettings(): ChannelsSettingsState {
  const [loadState, setLoadState] = useState<'loading' | 'error' | 'ready'>('loading')
  const [status, setStatus] = useState<ChannelsStatus | undefined>(undefined)
  const [tokenDraft, setTokenDraft] = useState('')
  const [bindingCode, setBindingCode] = useState<IssuedBindingCode | null>(null)
  const [pendingAction, setPendingAction] = useState<ChannelsAction | null>(null)
  const [actionError, setActionError] = useState<ChatChannelsErrorCode | null>(null)
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  const applyResult = useCallback(
    (result: Awaited<ReturnType<typeof window.api.chatChannels.getStatus>>): void => {
      if (!mountedRef.current) return
      if (result.status === 'ok') {
        setStatus({
          connection: result.connection,
          binding: result.binding,
          pendingBindingRequest: result.pendingBindingRequest
        })
        setLoadState('ready')
      } else {
        setLoadState('error')
      }
    },
    []
  )

  const refresh = useCallback((): void => {
    void window.api.chatChannels.getStatus().then(applyResult)
  }, [applyResult])

  useEffect(() => {
    refresh()
  }, [refresh])

  // 订阅连接状态与绑定请求推送：收到即刷新整体状态（含错误码）。
  useEffect(() => {
    const unsubscribe = window.api.chatChannels.onEvent(() => {
      void window.api.chatChannels.getStatus().then(applyResult)
    })
    return unsubscribe
  }, [applyResult])

  // 错误码由各动作回调自行落定（含协议错误分支）；这里只兜底未预期异常。
  const runAction = useCallback(
    (action: ChannelsAction, run: () => Promise<void>): void => {
      if (pendingAction) return
      setPendingAction(action)
      setActionError(null)
      void run()
        .catch(() => {
          if (mountedRef.current) setActionError('UNKNOWN_ERROR')
        })
        .finally(() => {
          if (mountedRef.current) setPendingAction(null)
        })
    },
    [pendingAction]
  )

  const configure = useCallback((): void => {
    const token = tokenDraft.trim()
    if (!token) return
    runAction('configure', async () => {
      const result = await window.api.chatChannels.configureConnection({ token })
      if (!mountedRef.current) return
      if (result.status === 'ok') {
        setStatus((previous) => ({
          connection: result.connection,
          binding:
            previous?.connection?.botId === result.connection.botId ? previous.binding : null,
          pendingBindingRequest:
            previous?.connection?.botId === result.connection.botId
              ? previous.pendingBindingRequest
              : null
        }))
        setLoadState('ready')
        refresh()
        setTokenDraft('')
      } else {
        setActionError(result.error.code)
      }
    })
  }, [refresh, runAction, tokenDraft])

  const connect = useCallback((): void => {
    runAction('connect', async () => {
      const result = await window.api.chatChannels.connect()
      if (!mountedRef.current) return
      if (result.status === 'ok') refresh()
      else setActionError(result.error.code)
    })
  }, [refresh, runAction])

  const disconnect = useCallback((): void => {
    runAction('disconnect', async () => {
      const result = await window.api.chatChannels.disconnect()
      if (!mountedRef.current) return
      if (result.status === 'ok') refresh()
      else setActionError(result.error.code)
    })
  }, [refresh, runAction])

  const issueBindingCode = useCallback((): void => {
    runAction('issueCode', async () => {
      const result = await window.api.chatChannels.issueBindingCode()
      if (!mountedRef.current) return
      if (result.status === 'ok') {
        // 有效期分钟数在签发时计算一次，渲染期不再读取时钟。
        setBindingCode({
          code: result.code.code,
          expiresAt: result.code.expiresAt,
          minutesValid: Math.max(
            1,
            Math.round((Date.parse(result.code.expiresAt) - Date.now()) / 60_000)
          )
        })
      } else {
        setActionError(result.error.code)
      }
    })
  }, [runAction])

  const confirmBinding = useCallback((): void => {
    runAction('confirmBinding', async () => {
      const result = await window.api.chatChannels.confirmBinding()
      if (!mountedRef.current) return
      if (result.status === 'ok') {
        setBindingCode(null)
        refresh()
      } else {
        setActionError(result.error.code)
      }
    })
  }, [refresh, runAction])

  const rejectBinding = useCallback((): void => {
    runAction('rejectBinding', async () => {
      const result = await window.api.chatChannels.rejectBinding()
      if (!mountedRef.current) return
      if (result.status === 'ok') refresh()
      else setActionError(result.error.code)
    })
  }, [refresh, runAction])

  const unbind = useCallback((): void => {
    runAction('unbind', async () => {
      const result = await window.api.chatChannels.unbind()
      if (!mountedRef.current) return
      if (result.status === 'ok') refresh()
      else setActionError(result.error.code)
    })
  }, [refresh, runAction])

  return {
    loadState,
    status,
    tokenDraft,
    bindingCode,
    pendingAction,
    actionError,
    setTokenDraft,
    refresh,
    configure,
    connect,
    disconnect,
    issueBindingCode,
    confirmBinding,
    rejectBinding,
    unbind
  }
}
