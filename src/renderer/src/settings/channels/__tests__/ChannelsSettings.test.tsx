// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { I18nextProvider } from 'react-i18next'
import type { ChatChannelsApi, ChatChannelsStatusResult } from '../../../../../shared/chat-channels'
import { createI18n } from '../../../i18n'
import { ChannelsSettings } from '../ChannelsSettings'
import { useChannelsSettings } from '../useChannelsSettings'

// 聊天平台设置区块：验证无连接配置、绑定确认与错误文案映射走 i18n。

const CONNECTION_ID = 'f9364f0f-f3f4-4ea6-a31d-b55754aa2477'
const BINDING_ID = '0d4b2f7e-52c8-4a61-9ac1-30b1e6de9d02'
const ISO = '2026-09-23T12:00:00.000Z'

function statusResult(
  overrides: Partial<Extract<ChatChannelsStatusResult, { status: 'ok' }>> = {}
): ChatChannelsStatusResult {
  return {
    status: 'ok' as const,
    connection: null,
    binding: null,
    pendingBindingRequest: null,
    ...overrides
  }
}

function chatChannelsApi(
  initial: ChatChannelsStatusResult
): ChatChannelsApi & { calls: { configure: string[] }; emitEvent(): void } {
  const calls = { configure: [] as string[] }
  let listener: ((event: unknown) => void) | null = null
  return {
    calls,
    emitEvent: () => listener?.({ type: 'bindingRequested' }),
    getStatus: vi.fn(async () => initial),
    configureConnection: vi.fn(async (input: { token: string }) => {
      calls.configure.push(input.token)
      return {
        status: 'ok' as const,
        connection: {
          connectionId: CONNECTION_ID,
          platform: 'telegram' as const,
          botId: '6000000001',
          botUsername: 'lingo_mate_bot',
          state: 'connected' as const,
          createdAt: ISO,
          updatedAt: ISO
        }
      }
    }),
    connect: vi.fn(async () => ({
      status: 'error' as const,
      error: { code: 'NOT_CONNECTED' as const }
    })),
    disconnect: vi.fn(async () => ({ status: 'ok' as const })),
    issueBindingCode: vi.fn(async () => ({
      status: 'ok' as const,
      code: { code: 'AB23CD', expiresAt: '2026-09-23T12:10:00.000Z' }
    })),
    confirmBinding: vi.fn(async () => ({
      status: 'ok' as const,
      binding: {
        bindingId: BINDING_ID,
        connectionId: CONNECTION_ID,
        platform: 'telegram' as const,
        senderId: '7000000001',
        displayName: 'Leon',
        boundAt: ISO
      }
    })),
    rejectBinding: vi.fn(async () => ({ status: 'ok' as const })),
    unbind: vi.fn(async () => ({ status: 'ok' as const })),
    onEvent: vi.fn((next: (event: unknown) => void) => {
      listener = next
      return () => {
        listener = null
      }
    })
  }
}

function TestHost({ api }: { api: ChatChannelsApi }): React.JSX.Element {
  const state = useChannelsSettings()
  void api
  return (
    <I18nextProvider i18n={createI18n('zh-CN')}>
      <ChannelsSettings state={state} />
    </I18nextProvider>
  )
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  window.api = undefined as unknown as typeof window.api
})

function stubApi(api: ChatChannelsApi): void {
  window.api = { chatChannels: api } as unknown as typeof window.api
}

describe('ChannelsSettings', () => {
  it('allows replacing the token after a connection has been configured', async () => {
    const api = chatChannelsApi(
      statusResult({
        connection: {
          connectionId: CONNECTION_ID,
          platform: 'telegram',
          botId: '6000000001',
          botUsername: 'lingo_mate_bot',
          state: 'error',
          errorCode: 'TOKEN_INVALID',
          createdAt: ISO,
          updatedAt: ISO
        }
      })
    )
    stubApi(api)
    render(<TestHost api={api} />)
    fireEvent.click(await screen.findByRole('button', { name: '更新 Bot Token / 更换机器人' }))
    fireEvent.change(screen.getByLabelText(/Bot Token/), { target: { value: 'new:TOKEN' } })
    fireEvent.click(screen.getByRole('button', { name: '连接' }))
    await waitFor(() =>
      expect(api.configureConnection).toHaveBeenCalledWith({ token: 'new:TOKEN' })
    )
  })

  it('shows the token setup form when no connection exists', async () => {
    const api = chatChannelsApi(statusResult())
    stubApi(api)
    render(<TestHost api={api} />)

    expect(await screen.findByLabelText(/Bot Token/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '连接' })).toBeDisabled()
  })

  it('submits the token once and clears the draft after success', async () => {
    const api = chatChannelsApi(statusResult())
    stubApi(api)
    render(<TestHost api={api} />)

    const input = await screen.findByLabelText(/Bot Token/)
    fireEvent.change(input, { target: { value: ' 123:TOKEN ' } })
    fireEvent.click(screen.getByRole('button', { name: '连接' }))
    await waitFor(() => {
      expect(api.configureConnection).toHaveBeenCalledWith({ token: '123:TOKEN' })
    })
    await waitFor(() => {
      expect((screen.queryByLabelText(/Bot Token/) as HTMLInputElement | null)?.value ?? '').toBe(
        ''
      )
    })
  })

  it('surfaces invalid token errors via i18n', async () => {
    const api = chatChannelsApi(statusResult())
    ;(api.configureConnection as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      status: 'error' as const,
      error: { code: 'TOKEN_INVALID' as const }
    })
    stubApi(api)
    render(<TestHost api={api} />)

    fireEvent.change(await screen.findByLabelText(/Bot Token/), { target: { value: 'bad' } })
    fireEvent.click(screen.getByRole('button', { name: '连接' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('机器人 Token 无效或已被撤销。')
  })

  it('guides binding code issuance and confirmation flow', async () => {
    const connectionView = {
      connectionId: CONNECTION_ID,
      platform: 'telegram' as const,
      botId: '6000000001',
      botUsername: 'lingo_mate_bot',
      state: 'connected' as const,
      createdAt: ISO,
      updatedAt: ISO
    }
    const withConnection = statusResult({ connection: connectionView })
    const api = chatChannelsApi(withConnection)
    stubApi(api)
    render(<TestHost api={api} />)

    fireEvent.click(await screen.findByRole('button', { name: '生成绑定码' }))
    expect(await screen.findByText(/绑定码：AB23CD/)).toBeInTheDocument()

    // 平台侧 /start 到达：Main 推送事件，设置页刷新出待确认请求。
    ;(api.getStatus as ReturnType<typeof vi.fn>).mockResolvedValue(
      statusResult({
        connection: connectionView,
        pendingBindingRequest: {
          bindingId: BINDING_ID,
          connectionId: CONNECTION_ID,
          platform: 'telegram' as const,
          senderId: '7000000001',
          displayName: 'Leon',
          requestedAt: ISO
        }
      })
    )
    api.emitEvent()
    await waitFor(() => {
      expect(screen.getByRole('button', { name: '确认绑定' })).toBeInTheDocument()
    })
    fireEvent.click(screen.getByRole('button', { name: '确认绑定' }))
    await waitFor(() => {
      expect(api.confirmBinding).toHaveBeenCalled()
    })
  })

  it('shows the bound account with unbind confirmation', async () => {
    const api = chatChannelsApi(
      statusResult({
        connection: {
          connectionId: CONNECTION_ID,
          platform: 'telegram' as const,
          botId: '6000000001',
          botUsername: 'lingo_mate_bot',
          state: 'connected' as const,
          createdAt: ISO,
          updatedAt: ISO
        },
        binding: {
          bindingId: BINDING_ID,
          connectionId: CONNECTION_ID,
          platform: 'telegram',
          senderId: '7000000001',
          displayName: 'Leon',
          boundAt: ISO
        }
      })
    )
    stubApi(api)
    render(<TestHost api={api} />)

    expect(await screen.findByText('已绑定：Leon')).toBeInTheDocument()
    // 区块按钮与确认弹窗按钮同名，按顺序区分：先区块按钮，再弹窗确认。
    fireEvent.click(screen.getAllByRole('button', { name: '解绑' })[0])
    expect(
      screen.getByText(/解绑后该账号将无法继续使用聊天功能，未发送的回复将被丢弃/)
    ).toBeInTheDocument()
    fireEvent.click(screen.getAllByRole('button', { name: '解绑' })[1])
    await waitFor(() => {
      expect(api.unbind).toHaveBeenCalled()
    })
  })

  it('renders connection state and webhook troubleshooting hint', async () => {
    const api = chatChannelsApi(
      statusResult({
        connection: {
          connectionId: CONNECTION_ID,
          platform: 'telegram' as const,
          botId: '6000000001',
          botUsername: 'lingo_mate_bot',
          state: 'error' as const,
          errorCode: 'WEBHOOK_CONFLICT' as const,
          createdAt: ISO,
          updatedAt: ISO
        }
      })
    )
    stubApi(api)
    render(<TestHost api={api} />)

    const state = await screen.findByText(/连接异常/)
    expect(state).toHaveTextContent('Webhook')
    expect(screen.getByText(/不会自动删除/)).toBeInTheDocument()
  })
})
