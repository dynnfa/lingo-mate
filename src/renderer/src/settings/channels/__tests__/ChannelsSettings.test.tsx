// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, render, screen, fireEvent, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { I18nextProvider } from 'react-i18next'
import { emptyCommunicationApi } from '../../../../../../tests/fixtures/communication'
import { createI18n } from '../../../i18n'
import { ChannelsSettings } from '../ChannelsSettings'
afterEach(cleanup)
it.each(['en', 'zh-CN'] as const)(
  'shows an honest translated empty state in %s',
  async (language) => {
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { communication: emptyCommunicationApi() }
    })
    render(
      <I18nextProvider i18n={createI18n(language)}>
        <ChannelsSettings active />
      </I18nextProvider>
    )
    expect(
      await screen.findByText(language === 'en' ? /No chat platform adapters/ : /尚未安装聊天平台/)
    ).toBeVisible()
    expect(
      screen.queryByRole('button', { name: language === 'en' ? 'Start' : '启动' })
    ).not.toBeInTheDocument()
  }
)
it('requires acknowledgement before retrying uncertain delivery and restores keyboard focus', async () => {
  const api = emptyCommunicationApi()
  const id = '21d48ac5-ddce-4002-aee5-e50a925d9701'
  api.snapshot = async () => ({
    status: 'ok',
    snapshot: {
      connections: [],
      bindings: [],
      challenges: [],
      requests: [],
      deliveries: [{ id, connectionId: id, state: 'uncertain' }]
    }
  })
  api.resolveDelivery = vi.fn(async () => ({ status: 'ok' as const }))
  Object.defineProperty(window, 'api', { configurable: true, value: { communication: api } })
  render(
    <I18nextProvider i18n={createI18n('en')}>
      <ChannelsSettings active />
    </I18nextProvider>
  )
  const retry = await screen.findByRole('button', { name: 'Retry saved delivery' })
  expect(retry).toBeDisabled()
  fireEvent.click(screen.getByRole('checkbox'))
  fireEvent.click(retry)
  await waitFor(() =>
    expect(api.resolveDelivery).toHaveBeenCalledWith({
      deliveryId: id,
      action: 'retry',
      acknowledgeDuplicate: true
    })
  )
  await waitFor(() => expect(screen.getByRole('button', { name: 'Refresh' })).toHaveFocus())
})
it('creates a stopped Telegram connection, clears tokens on submit and leaving, and focuses failed input', async () => {
  const api = emptyCommunicationApi()
  api.snapshot = async () => ({
    status: 'ok',
    snapshot: {
      installedAdapters: ['telegram'],
      connections: [],
      bindings: [],
      challenges: [],
      requests: [],
      deliveries: []
    }
  })
  api.createTelegramConnection = vi.fn(async () => ({
    status: 'error' as const,
    error: { code: 'TELEGRAM_UNAUTHORIZED' as const }
  }))
  Object.defineProperty(window, 'api', { configurable: true, value: { communication: api } })
  const view = (active: boolean): React.JSX.Element => (
    <I18nextProvider i18n={createI18n('en')}>
      <ChannelsSettings active={active} />
    </I18nextProvider>
  )
  const { rerender } = render(view(true))
  fireEvent.click(await screen.findByRole('button', { name: 'Add Telegram Bot' }))
  const input = screen.getByLabelText('Bot Token')
  expect(input).toHaveAttribute('type', 'password')
  const token = '123456:abcdefghijklmnopqrstuvwxyz123456789'
  fireEvent.change(input, { target: { value: token } })
  fireEvent.submit(input.closest('form')!)
  await waitFor(() => expect(api.createTelegramConnection).toHaveBeenCalledWith({ token }))
  expect(input).toHaveValue('')
  await waitFor(() => expect(input).toHaveFocus())
  expect(screen.getByRole('alert')).toHaveTextContent('Token')
  fireEvent.change(input, { target: { value: token } })
  rerender(view(false))
  rerender(view(true))
  expect(screen.getByLabelText('Bot Token')).toHaveValue('')
})
it.each(['en', 'zh-CN'] as const)(
  'shows Telegram identity and supports credential replacement and deletion in %s',
  async (language) => {
    const api = emptyCommunicationApi()
    const id = '21d48ac5-ddce-4002-aee5-e50a925d9701'
    api.snapshot = async () => ({
      status: 'ok',
      snapshot: {
        installedAdapters: ['telegram'],
        connections: [
          {
            id,
            adapterId: 'telegram',
            state: 'stopped',
            hasCredential: true,
            botId: '123456',
            username: 'lingo_bot'
          }
        ],
        bindings: [],
        challenges: [],
        requests: [],
        deliveries: []
      }
    })
    api.setCredential = vi.fn(async () => ({ status: 'ok' as const }))
    api.deleteConnection = vi.fn(async () => ({ status: 'ok' as const }))
    Object.defineProperty(window, 'api', { configurable: true, value: { communication: api } })
    render(
      <I18nextProvider i18n={createI18n(language)}>
        <ChannelsSettings active />
      </I18nextProvider>
    )
    expect(await screen.findByText(/@lingo_bot/)).toHaveTextContent('123456')
    fireEvent.click(
      screen.getByRole('button', { name: language === 'en' ? 'Replace Token' : '替换 Token' })
    )
    const input = screen.getByLabelText('Bot Token')
    const token = '123456:abcdefghijklmnopqrstuvwxyz123456789'
    fireEvent.change(input, { target: { value: token } })
    fireEvent.submit(input.closest('form')!)
    await waitFor(() =>
      expect(api.setCredential).toHaveBeenCalledWith({ connectionId: id, credential: token })
    )
    await waitFor(() => expect(screen.queryByLabelText('Bot Token')).not.toBeInTheDocument())
    fireEvent.click(
      screen.getByRole('button', { name: language === 'en' ? 'Delete connection' : '删除连接' })
    )
    fireEvent.click(
      screen.getByRole('button', { name: language === 'en' ? 'Confirm deletion' : '确认删除' })
    )
    await waitFor(() => expect(api.deleteConnection).toHaveBeenCalledWith({ connectionId: id }))
  }
)
