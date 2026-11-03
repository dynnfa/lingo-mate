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
