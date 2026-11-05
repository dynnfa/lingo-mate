// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { I18nextProvider } from 'react-i18next'
import { emptyCommunicationApi } from '../../../../../../tests/fixtures/communication'
import type { CommunicationApi, CommunicationSnapshot } from '../../../../../shared/communication'
import { createI18n } from '../../../i18n'
import { ChannelsSettings } from '../ChannelsSettings'

const id = '21d48ac5-ddce-4002-aee5-e50a925d9701'
const otherId = '21d48ac5-ddce-4002-aee5-e50a925d9702'
const newestId = '21d48ac5-ddce-4002-aee5-e50a925d9703'
const token = '123456:abcdefghijklmnopqrstuvwxyz123456789'
const createdAt = Date.UTC(2026, 10, 5, 9, 30)
afterEach(cleanup)

function setup(
  language: 'en' | 'zh-CN' = 'en',
  connections: CommunicationSnapshot['connections'] = []
): {
  api: CommunicationApi
  snapshot: CommunicationSnapshot
  setActive: (active: boolean) => void
} {
  const api = emptyCommunicationApi()
  const snapshot: CommunicationSnapshot = { installedAdapters: ['telegram'], connections }
  api.snapshot = vi.fn(async () => ({ status: 'ok' as const, snapshot }))
  Object.defineProperty(window, 'api', { configurable: true, value: { communication: api } })
  const i18n = createI18n(language)
  const view = (active: boolean): React.JSX.Element => (
    <I18nextProvider i18n={i18n}>
      <ChannelsSettings active={active} />
    </I18nextProvider>
  )
  const { rerender } = render(view(true))
  return { api, snapshot, setActive: (active: boolean) => rerender(view(active)) }
}

it.each([
  ['en', 'Add channel', 'Channel type'],
  ['zh-CN', '添加渠道', '渠道类型']
] as const)(
  'shows only the translated add button when empty in %s',
  async (language, add, type) => {
    const { api } = setup(language)
    const button = screen.getByRole('button', { name: add })
    await waitFor(() => expect(api.snapshot).toHaveBeenCalledTimes(1))
    expect(screen.getAllByRole('button')).toEqual([button])
    expect(screen.queryByRole('article')).not.toBeInTheDocument()
    fireEvent.click(button)
    const dialog = screen.getByRole('dialog', { name: add })
    const select = within(dialog).getByRole('combobox', { name: type })
    expect(select).toHaveFocus()
    expect(within(dialog).queryByLabelText('Bot Token')).not.toBeInTheDocument()
    expect(within(select).getByRole('option', { name: 'Telegram' })).toBeInTheDocument()
    fireEvent.keyDown(select, { key: 'Escape' })
    expect(dialog).not.toBeInTheDocument()
    expect(button).toHaveFocus()
  }
)

it('clears a failed token, adds a card on success and discards a draft on leaving', async () => {
  const { api, snapshot, setActive } = setup()
  api.createTelegramConnection = vi
    .fn<typeof api.createTelegramConnection>(async () => {
      snapshot.connections = [{ id, adapterId: 'telegram', username: 'lingo_bot', createdAt }]
      return { status: 'ok' as const, connectionId: id }
    })
    .mockResolvedValueOnce({ status: 'error', error: { code: 'TELEGRAM_UNAUTHORIZED' } })
  const add = screen.getByRole('button', { name: 'Add channel' })
  const selectTelegram = async (): Promise<HTMLElement> => {
    const trigger = screen.getByRole('button', { name: 'Add channel' })
    await waitFor(() => expect(trigger).toBeEnabled())
    fireEvent.click(trigger)
    const select = await screen.findByRole('combobox', { name: 'Channel type' })
    await within(select).findByRole('option', { name: 'Telegram' })
    fireEvent.change(select, { target: { value: 'telegram' } })
    return screen.getByLabelText('Bot Token')
  }
  const input = await selectTelegram()
  expect(input).toHaveAttribute('type', 'password')
  fireEvent.change(input, { target: { value: token } })
  fireEvent.submit(input.closest('form')!)
  await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/invalid|revoked/i))
  expect(input).toHaveValue('')
  expect(input).toHaveFocus()
  fireEvent.change(input, { target: { value: token } })
  fireEvent.click(screen.getByRole('button', { name: 'Save connection' }))
  expect(await screen.findByRole('article', { name: 'Telegram · @lingo_bot' })).toBeVisible()
  expect(api.createTelegramConnection).toHaveBeenNthCalledWith(2, { token })
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  expect(add).toHaveFocus()
  fireEvent.change(await selectTelegram(), { target: { value: token } })
  setActive(false)
  setActive(true)
  expect(await selectTelegram()).toHaveValue('')
})

it('shows newest cards first and tests only the selected channel', async () => {
  const { api } = setup('en', [
    { id: otherId, adapterId: 'telegram', username: 'older_bot' },
    { id, adapterId: 'telegram', username: 'lingo_bot', createdAt },
    { id: newestId, adapterId: 'telegram', username: 'newest_bot', createdAt: createdAt + 1 }
  ])
  let finish!: (result: Awaited<ReturnType<typeof api.testConnection>>) => void
  api.testConnection = vi.fn<typeof api.testConnection>(
    () =>
      new Promise((resolve) => {
        finish = resolve
      })
  )
  const cards = await screen.findAllByRole('article')
  expect(cards.map((card) => within(card).getByRole('heading').textContent)).toEqual([
    'Telegram · @newest_bot',
    'Telegram · @lingo_bot',
    'Telegram · @older_bot'
  ])
  expect(cards[1].querySelector('time')).toHaveAttribute(
    'datetime',
    new Date(createdAt).toISOString()
  )
  expect(within(cards[2]).getByText('Date added unknown')).toBeVisible()
  const test = within(cards[1]).getByRole('button', { name: 'Test connection' })
  expect(
    within(cards[1])
      .getAllByRole('button')
      .map((button) => button.textContent)
  ).toEqual(['Test connection', 'Edit Token', 'Delete'])
  fireEvent.click(test)
  expect(test).toHaveAttribute('aria-disabled', 'true')
  expect(within(cards[0]).getByRole('button', { name: 'Test connection' })).toBeEnabled()
  expect(api.testConnection).toHaveBeenCalledWith({ connectionId: id })
  finish({ status: 'error', error: { code: 'TELEGRAM_NETWORK' } })
  const dialog = await screen.findByRole('dialog', { name: 'Connection test' })
  expect(dialog).toHaveTextContent('Telegram · @lingo_bot')
  expect(dialog).toHaveTextContent(/connect to Telegram/i)
  fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }))
  expect(test).toHaveFocus()
  fireEvent.click(test)
  finish({ status: 'ok' })
  expect(await screen.findByText('Telegram is reachable and the Bot Token is valid.')).toBeVisible()
})

it('edits with a blank token and removes the card only after deletion is confirmed', async () => {
  const { api, snapshot } = setup('zh-CN', [
    { id, adapterId: 'telegram', username: 'lingo_bot', createdAt }
  ])
  api.setCredential = vi.fn(async () => ({ status: 'ok' as const }))
  api.deleteConnection = vi.fn(async () => {
    snapshot.connections = []
    return { status: 'ok' as const }
  })
  const card = await screen.findByRole('article', { name: 'Telegram · @lingo_bot' })
  const edit = within(card).getByRole('button', { name: '编辑 Token' })
  fireEvent.click(edit)
  const input = within(screen.getByRole('dialog', { name: '编辑 Token' })).getByLabelText(
    'Bot Token'
  )
  expect(input).toHaveValue('')
  expect(input).toHaveFocus()
  fireEvent.change(input, { target: { value: token } })
  fireEvent.submit(input.closest('form')!)
  await waitFor(() => expect(edit).toHaveFocus())
  expect(api.setCredential).toHaveBeenCalledWith({ connectionId: id, credential: token })
  fireEvent.click(within(card).getByRole('button', { name: '删除' }))
  expect(api.deleteConnection).not.toHaveBeenCalled()
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '确认删除' }))
  await waitFor(() => expect(card).not.toBeInTheDocument())
  expect(api.deleteConnection).toHaveBeenCalledWith({ connectionId: id })
  await waitFor(() => expect(screen.getByRole('button', { name: '添加渠道' })).toHaveFocus())
})

it('can retry loading the cards after a failure', async () => {
  const { api, snapshot } = setup()
  api.snapshot = vi
    .fn(async () => ({ status: 'ok' as const, snapshot }))
    .mockRejectedValueOnce(new Error('load failed'))
  expect(await screen.findByRole('alert')).toHaveTextContent('Could not load channels.')
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
  await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument())
})
