// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen, fireEvent, waitFor, within } from '@testing-library/react'
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
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

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
  api.snapshot = vi.fn(async () => ({ status: 'ok' as const, snapshot: structuredClone(snapshot) }))
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
      snapshot.connections = [
        { id, adapterId: 'telegram', username: 'lingo_bot', createdAt, started: false }
      ]
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
  const reminder = await screen.findByRole('dialog', { name: 'Bind your Telegram account' })
  expect(reminder).toHaveTextContent(/Start the channel/)
  fireEvent.click(within(reminder).getByRole('button', { name: 'Got it' }))
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  expect(add).toHaveFocus()
  fireEvent.change(await selectTelegram(), { target: { value: token } })
  setActive(false)
  setActive(true)
  expect(await selectTelegram()).toHaveValue('')
})

it('shows newest cards first and tests only the selected channel', async () => {
  const { api } = setup('en', [
    { id: otherId, adapterId: 'telegram', username: 'older_bot', started: false },
    { id, adapterId: 'telegram', username: 'lingo_bot', createdAt, started: false },
    {
      id: newestId,
      adapterId: 'telegram',
      username: 'newest_bot',
      createdAt: createdAt + 1,
      started: false
    }
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
      .filter((button) => button.closest('.channel-actions'))
      .map((button) => button.textContent)
  ).toEqual(['Start', 'Test connection', 'Edit Token', 'Delete'])
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

it.each([
  ['en', 'Binding code', 'Generate binding code', 'Copy binding command'],
  ['zh-CN', '绑定码', '生成绑定码', '复制绑定命令']
] as const)(
  'generates and copies a binding code for an existing connection in %s',
  async (language, label, generate, copy) => {
    const { api, snapshot } = setup(language, [{ id, adapterId: 'telegram', started: false }])
    api.createChallenge = vi.fn(async () => {
      const expiresAt = Date.now() + 300_000
      snapshot.connections[0].bindingChallenge = { challengeId: otherId, expiresAt }
      return { status: 'ok' as const, challengeId: otherId, code: 'one-time-code', expiresAt }
    })
    const writeText = vi.fn(async () => {})
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    const card = await screen.findByRole('article')
    expect(within(card).getByLabelText(label)).toHaveValue('')
    fireEvent.click(within(card).getByRole('button', { name: generate }))
    await waitFor(() => expect(within(card).getByLabelText(label)).toHaveValue('one-time-code'))
    expect(api.createChallenge).toHaveBeenCalledWith({
      connectionId: id,
      capabilities: ['chat', 'sentence']
    })
    fireEvent.click(within(card).getByRole('button', { name: copy }))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('/bind one-time-code'))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  }
)

it('automatically generates a code and reminds only after creation, not after editing or revisiting', async () => {
  const { api, snapshot, setActive } = setup()
  api.createTelegramConnection = vi.fn(async () => {
    snapshot.connections = [{ id, adapterId: 'telegram', started: false }]
    return { status: 'ok' as const, connectionId: id }
  })
  api.createChallenge = vi.fn(async () => {
    const expiresAt = Date.now() + 300_000
    snapshot.connections[0].bindingChallenge = { challengeId: otherId, expiresAt }
    return { status: 'ok' as const, challengeId: otherId, code: 'new-code', expiresAt }
  })
  await waitFor(() => expect(screen.getByRole('button', { name: 'Add channel' })).toBeEnabled())
  fireEvent.click(screen.getByRole('button', { name: 'Add channel' }))
  fireEvent.change(screen.getByRole('combobox'), { target: { value: 'telegram' } })
  fireEvent.change(screen.getByLabelText('Bot Token'), { target: { value: token } })
  fireEvent.click(screen.getByRole('button', { name: 'Save connection' }))
  const reminder = await screen.findByRole('dialog', { name: 'Bind your Telegram account' })
  expect(api.createChallenge).toHaveBeenCalledTimes(1)
  fireEvent.click(within(reminder).getByRole('button', { name: 'Got it' }))
  expect(screen.getByLabelText('Binding code')).toHaveValue('new-code')
  fireEvent.click(screen.getByRole('button', { name: 'Edit Token' }))
  fireEvent.change(screen.getByLabelText('Bot Token'), { target: { value: token } })
  fireEvent.click(screen.getByRole('button', { name: 'Save Token' }))
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  setActive(false)
  setActive(true)
  await screen.findByRole('article')
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  expect(screen.getByLabelText('Binding code')).toHaveValue('')
  expect(api.createChallenge).toHaveBeenCalledTimes(1)
})

it('shows the candidate identity and completes binding only on explicit confirmation', async () => {
  const { api, snapshot } = setup('en', [
    {
      id,
      adapterId: 'telegram',
      started: true,
      bindingCount: 0,
      bindingChallenge: {
        challengeId: otherId,
        expiresAt: Date.now() + 300_000,
        externalActorId: '12345',
        displayName: 'Alice'
      }
    }
  ])
  api.confirmBinding = vi.fn(async () => {
    snapshot.connections = [{ id, adapterId: 'telegram', started: true, bindingCount: 1 }]
    return { status: 'ok' as const }
  })
  const card = await screen.findByRole('article')
  expect(card).toHaveTextContent('Alice')
  expect(card).toHaveTextContent('12345')
  expect(api.confirmBinding).not.toHaveBeenCalled()
  fireEvent.click(within(card).getByRole('button', { name: 'Confirm account binding' }))
  await waitFor(() => expect(api.confirmBinding).toHaveBeenCalledWith({ challengeId: otherId }))
  expect(await within(card).findByText('Bound account: 1')).toBeVisible()
  expect(
    within(card).queryByRole('button', { name: 'Confirm account binding' })
  ).not.toBeInTheDocument()
})

it('edits with a blank token and removes the card only after deletion is confirmed', async () => {
  const { api, snapshot } = setup('zh-CN', [
    { id, adapterId: 'telegram', username: 'lingo_bot', createdAt, started: false }
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

it.each([
  ['en', 'Start', 'Stop', 'Started'],
  ['zh-CN', '启动', '停止', '已启动']
] as const)(
  'starts a channel, shows the started state and stops it again in %s',
  async (language, start, stop, started) => {
    const { api, snapshot } = setup(language, [
      { id, adapterId: 'telegram', username: 'lingo_bot', createdAt, started: false }
    ])
    let finish!: (result: Awaited<ReturnType<typeof api.start>>) => void
    api.start = vi.fn<typeof api.start>(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    api.stop = vi.fn<typeof api.stop>(async () => {
      snapshot.connections = [
        { id, adapterId: 'telegram', username: 'lingo_bot', createdAt, started: false }
      ]
      return { status: 'ok' as const }
    })
    const card = await screen.findByRole('article', { name: 'Telegram · @lingo_bot' })
    const startButton = within(card).getByRole('button', { name: start })
    fireEvent.click(startButton)
    expect(startButton).toHaveAttribute('aria-disabled', 'true')
    expect(api.start).toHaveBeenCalledWith({ connectionId: id })
    snapshot.connections = [
      { id, adapterId: 'telegram', username: 'lingo_bot', createdAt, started: true }
    ]
    finish({ status: 'ok' })
    expect(await within(card).findByText(started)).toBeVisible()
    expect(within(card).queryByRole('button', { name: start })).not.toBeInTheDocument()
    const stopButton = within(card).getByRole('button', { name: stop })
    expect(stopButton).toHaveFocus()
    fireEvent.click(stopButton)
    await waitFor(() => expect(api.stop).toHaveBeenCalledWith({ connectionId: id }))
    expect(await within(card).findByRole('button', { name: start })).toBeInTheDocument()
    expect(within(card).getByRole('button', { name: start })).toHaveFocus()
    expect(within(card).queryByText(started)).not.toBeInTheDocument()
  }
)

it('shows a translated start failure on the card and keeps the start action', async () => {
  const { api } = setup('zh-CN', [
    { id, adapterId: 'telegram', username: 'lingo_bot', createdAt, started: false }
  ])
  api.start = vi.fn(async () => ({
    status: 'error' as const,
    error: { code: 'TELEGRAM_WEBHOOK_CONFLICT' as const }
  }))
  const card = await screen.findByRole('article', { name: 'Telegram · @lingo_bot' })
  fireEvent.click(within(card).getByRole('button', { name: '启动' }))
  await waitFor(() => expect(within(card).getByRole('alert')).toHaveTextContent(/webhook/i))
  const retry = within(card).getByRole('button', { name: '启动' })
  expect(retry).toBeEnabled()
  expect(retry).not.toHaveAttribute('aria-disabled', 'true')
  expect(retry).toHaveFocus()
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

it('polls binding progress, hides expired codes and can generate a replacement', async () => {
  vi.useFakeTimers()
  const { api, snapshot } = setup('en', [{ id, adapterId: 'telegram', started: true }])
  let generations = 0
  api.createChallenge = vi.fn(async () => {
    const expiresAt = Date.now() + 300_000
    const challengeId = ++generations === 1 ? otherId : newestId
    snapshot.connections[0].bindingChallenge = { challengeId, expiresAt }
    return { status: 'ok' as const, challengeId, expiresAt, code: `code-${challengeId}` }
  })
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1)
  })
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Generate binding code' }))
  })
  expect(screen.getByLabelText('Binding code')).toHaveValue(`code-${otherId}`)
  snapshot.connections[0].bindingChallenge!.externalActorId = '12345'
  snapshot.connections[0].bindingChallenge!.displayName = 'Alice'
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2000)
  })
  expect(screen.getByRole('button', { name: 'Confirm account binding' })).toBeVisible()
  expect(screen.getByText(/Alice/)).toBeVisible()
  await act(async () => {
    await vi.advanceTimersByTimeAsync(300_000)
  })
  expect(screen.getByLabelText('Binding code')).toHaveValue('')
  expect(screen.getByText('The binding code has expired. Generate a new one.')).toBeVisible()
  expect(screen.queryByRole('button', { name: 'Copy binding command' })).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'Confirm account binding' })).not.toBeInTheDocument()
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Generate new binding code' }))
  })
  expect(screen.getByLabelText('Binding code')).toHaveValue(`code-${newestId}`)
  expect(screen.queryByText(/Alice/)).not.toBeInTheDocument()
})

it('keeps the new connection when code generation fails and allows retry without creating another Bot', async () => {
  const { api, snapshot } = setup('zh-CN')
  api.createTelegramConnection = vi.fn(async () => {
    snapshot.connections = [{ id, adapterId: 'telegram', started: false }]
    return { status: 'ok' as const, connectionId: id }
  })
  api.createChallenge = vi
    .fn(async () => {
      const expiresAt = Date.now() + 300_000
      snapshot.connections[0].bindingChallenge = { challengeId: otherId, expiresAt }
      return { status: 'ok' as const, challengeId: otherId, code: 'retry-code', expiresAt }
    })
    .mockRejectedValueOnce(new Error('transport error'))
  await waitFor(() => expect(screen.getByRole('button', { name: '添加渠道' })).toBeEnabled())
  fireEvent.click(screen.getByRole('button', { name: '添加渠道' }))
  fireEvent.change(screen.getByRole('combobox'), { target: { value: 'telegram' } })
  fireEvent.change(screen.getByLabelText('Bot Token'), { target: { value: token } })
  fireEvent.click(screen.getByRole('button', { name: '保存连接' }))
  const reminder = await screen.findByRole('dialog', { name: '请绑定 Telegram 账号' })
  expect(reminder).toHaveTextContent('绑定完成前，发送消息不会收到回复。')
  const gotIt = within(reminder).getByRole('button', { name: '知道了' })
  expect(gotIt).toHaveFocus()
  fireEvent.keyDown(gotIt, { key: 'Escape' })
  expect(screen.getByRole('button', { name: '添加渠道' })).toHaveFocus()
  const card = screen.getByRole('article')
  expect(within(card).getByRole('alert')).toHaveTextContent('渠道操作失败，请重试。')
  fireEvent.click(within(card).getByRole('button', { name: '生成绑定码' }))
  await waitFor(() => expect(within(card).getByLabelText('绑定码')).toHaveValue('retry-code'))
  expect(api.createTelegramConnection).toHaveBeenCalledTimes(1)
  expect(within(card).queryByRole('alert')).not.toBeInTheDocument()
})

it('does not confirm or keep displaying a code superseded by another binding challenge', async () => {
  const { api, snapshot } = setup('en', [{ id, adapterId: 'telegram', started: true }])
  api.createChallenge = vi.fn(async () => {
    const expiresAt = Date.now() + 300_000
    snapshot.connections[0].bindingChallenge = {
      challengeId: otherId,
      expiresAt,
      externalActorId: '12345',
      displayName: 'Alice'
    }
    return { status: 'ok' as const, challengeId: otherId, code: 'old-code', expiresAt }
  })
  await screen.findByRole('article')
  fireEvent.click(screen.getByRole('button', { name: 'Generate binding code' }))
  await waitFor(() => expect(screen.getByLabelText('Binding code')).toHaveValue('old-code'))
  api.confirmBinding = vi.fn(async () => {
    snapshot.connections[0].bindingChallenge = {
      challengeId: newestId,
      expiresAt: Date.now() + 300_000
    }
    return { status: 'error' as const, error: { code: 'CHALLENGE_INVALID' as const } }
  })
  fireEvent.click(screen.getByRole('button', { name: 'Confirm account binding' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('The code has expired or is invalid.')
  expect(screen.getByLabelText('Binding code')).toHaveValue('')
  expect(screen.queryByText(/Alice/)).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'Copy binding command' })).not.toBeInTheDocument()
})

it('shows the automatically generated code even if polling discovers the new card before generation completes', async () => {
  vi.useFakeTimers()
  const expiresAt = Date.now() + 300_000
  const { api, snapshot } = setup('en', [
    {
      id: otherId,
      adapterId: 'telegram',
      started: true,
      bindingChallenge: { challengeId: newestId, expiresAt }
    }
  ])
  api.createTelegramConnection = vi.fn(async () => {
    snapshot.connections.push({ id, adapterId: 'telegram', username: 'new_bot', started: false })
    return { status: 'ok' as const, connectionId: id }
  })
  let finish!: (result: Awaited<ReturnType<typeof api.createChallenge>>) => void
  api.createChallenge = vi.fn<typeof api.createChallenge>(
    () =>
      new Promise((resolve) => {
        finish = resolve
      })
  )
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1)
  })
  fireEvent.click(screen.getByRole('button', { name: 'Add channel' }))
  fireEvent.change(screen.getByRole('combobox'), { target: { value: 'telegram' } })
  fireEvent.change(screen.getByLabelText('Bot Token'), { target: { value: token } })
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Save connection' }))
  })
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2000)
  })
  expect(screen.getByRole('article', { name: 'Telegram · @new_bot' })).toBeInTheDocument()
  snapshot.connections[1].bindingChallenge = { challengeId: id, expiresAt }
  await act(async () => {
    finish({ status: 'ok', challengeId: id, code: 'late-code', expiresAt })
  })
  fireEvent.click(screen.getByRole('button', { name: 'Got it' }))
  expect(
    within(screen.getByRole('article', { name: 'Telegram · @new_bot' })).getByLabelText(
      'Binding code'
    )
  ).toHaveValue('late-code')
})
