// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { I18nextProvider } from 'react-i18next'
import { createI18n } from '../../../i18n'
import { SPEECH_IDENTITY, type SpeechApi } from '../../../../../shared/speech'
import { AudioPlayer } from '../../../speech/audio-player'
import * as speechController from '../../../speech/speech-controller'
import { SentenceDetail } from '../SentenceDetail'

const entry = {
  id: '11111111-1111-4111-8111-111111111111',
  sourceText: '今天先这样吧。',
  translation: "Let's call it a day.",
  targetLanguage: 'en' as const,
  createdAt: '2026-10-29T00:00:00.000Z'
}

let playback: speechController.SpeechController
let synthesize: ReturnType<typeof vi.fn<SpeechApi['synthesize']>>
let stopAudio: ReturnType<typeof vi.fn<() => void>>

beforeEach(() => {
  synthesize = vi.fn<SpeechApi['synthesize']>().mockImplementation(async ({ requestId, text }) => ({
    status: 'ok',
    result: {
      requestId,
      text,
      language: 'en',
      identity: SPEECH_IDENTITY.revision,
      settings: { voice: 'af_bella', speed: 1 },
      audio: new Uint8Array(46),
      durationSeconds: 2,
      words: []
    }
  }))
  stopAudio = vi.fn<() => void>()
  playback = new speechController.SpeechController(
    { synthesize, cancel: vi.fn().mockResolvedValue({ status: 'ok' }) },
    new AudioPlayer({
      unlock: async () => {},
      decode: async () => ({ durationSeconds: 2, start: () => ({ stop: stopAudio }) }),
      currentTime: () => 5,
      now: () => 1000,
      getState: () => 'running',
      getOutputTimestamp: () => ({ contextTime: 5, performanceTime: 1000 }),
      close: async () => {}
    }),
    { request: () => 1, cancel: () => {} }
  )
  vi.spyOn(speechController, 'getSpeechController').mockReturnValue(playback)
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

it.each([
  { locale: 'zh-CN' as const, title: '语句', headers: ['原文', '译文', '操作'], speak: '朗读：' },
  {
    locale: 'en' as const,
    title: 'Sentences',
    headers: ['Original', 'Translation', 'Actions'],
    speak: 'Read aloud: '
  }
])(
  'shows three columns and reads only the complete translation in $locale',
  async ({ locale, title, headers, speak }) => {
    const translation = `${entry.translation}\nWe can pick this up tomorrow.`
    vi.stubGlobal('api', {
      sentence: {
        list: vi.fn().mockResolvedValue({ status: 'ok', entries: [{ ...entry, translation }] }),
        delete: vi.fn()
      }
    })
    const { container } = render(
      <I18nextProvider i18n={createI18n(locale)}>
        <SentenceDetail />
      </I18nextProvider>
    )
    const table = await screen.findByRole('table')
    expect(screen.getByRole('heading', { name: title })).toBeInTheDocument()
    expect(
      within(table)
        .getAllByRole('columnheader')
        .map((header) => header.textContent)
    ).toEqual(headers)
    const cells = within(within(table).getAllByRole('row')[1]).getAllByRole('cell')
    expect(cells).toHaveLength(3)
    expect(cells[0]).toHaveTextContent(entry.sourceText)
    expect(within(cells[0]).queryByRole('button')).not.toBeInTheDocument()
    expect(container.querySelector('time')).not.toBeInTheDocument()
    fireEvent.click(within(cells[1]).getByRole('button', { name: `${speak}${translation}` }))
    await waitFor(() => expect(playback.getState().status).toBe('playing'))
    expect(synthesize).toHaveBeenCalledWith({
      requestId: expect.any(String),
      text: translation,
      language: 'en'
    })
    expect(playback.getState()).toMatchObject({
      sourceId: `sentence:${entry.id}:translation`,
      text: translation
    })
  }
)

it.each([
  { result: { status: 'ok', entries: [] }, message: '还没有收藏语句' },
  { result: { status: 'error', error: { code: 'STORAGE_FAILED' } }, message: '语句读取失败' }
])('uses the renamed loading and result text: $message', async ({ result, message }) => {
  vi.stubGlobal('api', {
    sentence: { list: vi.fn().mockResolvedValue(result), delete: vi.fn() }
  })
  render(
    <I18nextProvider i18n={createI18n('zh-CN')}>
      <SentenceDetail />
    </I18nextProvider>
  )
  expect(screen.getByText('正在加载语句…')).toBeInTheDocument()
  expect(await screen.findByText(message)).toBeInTheDocument()
  if (result.status === 'ok') {
    expect(
      screen.getByText('在对话中使用 /sentence 命令收藏语句后，会在这里展示。')
    ).toBeInTheDocument()
  }
})

it('shows original and translation, confirms deletion, and returns focus to the heading', async () => {
  const remove = vi.fn().mockResolvedValue({ status: 'ok', id: entry.id, deleted: true })
  vi.stubGlobal('api', {
    sentence: {
      list: vi.fn().mockResolvedValue({ status: 'ok', entries: [entry] }),
      delete: remove
    }
  })
  render(
    <I18nextProvider i18n={createI18n('zh-CN')}>
      <SentenceDetail />
    </I18nextProvider>
  )
  expect(await screen.findByText(entry.sourceText)).toBeInTheDocument()
  expect(screen.getByText(entry.translation)).toBeInTheDocument()
  expect(screen.getByRole('table')).toHaveAccessibleName('已收藏语句列表')
  fireEvent.click(screen.getByRole('button', { name: `朗读：${entry.translation}` }))
  await waitFor(() => expect(playback.getState().status).toBe('playing'))
  fireEvent.click(screen.getByRole('button', { name: `删除 ${entry.sourceText}` }))
  expect(screen.getByRole('dialog', { name: '删除语句' })).toBeInTheDocument()
  expect(remove).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: '删除' }))
  await waitFor(() => expect(remove).toHaveBeenCalledWith({ id: entry.id }))
  await waitFor(() => expect(screen.getByRole('heading', { name: '语句' })).toHaveFocus())
  expect(screen.queryByText(entry.translation)).not.toBeInTheDocument()
  expect(stopAudio).toHaveBeenCalledTimes(1)
  expect(playback.getState().sourceId).toBeNull()
})

it('switches between records with identical translations, stops on click, and cleans up on unmount', async () => {
  const second = {
    ...entry,
    id: '22222222-2222-4222-8222-222222222222',
    sourceText: '今天就到这里吧。'
  }
  vi.stubGlobal('api', {
    sentence: {
      list: vi.fn().mockResolvedValue({ status: 'ok', entries: [entry, second] }),
      delete: vi.fn()
    }
  })
  const { unmount } = render(
    <I18nextProvider i18n={createI18n('zh-CN')}>
      <SentenceDetail />
    </I18nextProvider>
  )
  const table = await screen.findByRole('table')
  const rows = within(table)
    .getAllByRole('row')
    .slice(1)
    .map((row) => within(row))
  fireEvent.click(rows[0].getByRole('button', { name: `朗读：${entry.translation}` }))
  await waitFor(() => expect(playback.getState().status).toBe('playing'))
  expect(rows[1].getByRole('button', { name: `朗读：${entry.translation}` })).toHaveAttribute(
    'aria-pressed',
    'false'
  )
  fireEvent.click(rows[1].getByRole('button', { name: `朗读：${entry.translation}` }))
  await waitFor(() =>
    expect(playback.getState()).toMatchObject({
      status: 'playing',
      sourceId: `sentence:${second.id}:translation`
    })
  )
  expect(stopAudio).toHaveBeenCalledTimes(1)
  expect(rows[0].getByRole('button', { name: `朗读：${entry.translation}` })).toHaveAttribute(
    'aria-pressed',
    'false'
  )
  fireEvent.click(rows[1].getByRole('button', { name: `停止朗读：${entry.translation}` }))
  expect(playback.getState().sourceId).toBeNull()
  expect(stopAudio).toHaveBeenCalledTimes(2)
  fireEvent.click(rows[1].getByRole('button', { name: `朗读：${entry.translation}` }))
  await waitFor(() => expect(playback.getState().status).toBe('playing'))
  unmount()
  expect(playback.getState().sourceId).toBeNull()
  expect(stopAudio).toHaveBeenCalledTimes(3)
})

it('retries initial and subsequent page failures using the same cursor', async () => {
  const cursor = { createdAt: entry.createdAt, id: entry.id }
  const second = {
    ...entry,
    id: '22222222-2222-4222-8222-222222222222',
    sourceText: '明天继续。',
    translation: 'We can pick this up tomorrow.'
  }
  const list = vi
    .fn()
    .mockResolvedValueOnce({ status: 'error', error: { code: 'STORAGE_FAILED' } })
    .mockResolvedValueOnce({ status: 'ok', entries: [entry], nextCursor: cursor })
    .mockResolvedValueOnce({ status: 'error', error: { code: 'STORAGE_FAILED' } })
    .mockResolvedValueOnce({ status: 'ok', entries: [second] })
  vi.stubGlobal('api', { sentence: { list, delete: vi.fn() } })
  render(
    <I18nextProvider i18n={createI18n('zh-CN')}>
      <SentenceDetail />
    </I18nextProvider>
  )
  fireEvent.click(await screen.findByRole('button', { name: '重试' }))
  expect(await screen.findByText(entry.translation)).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: '加载更多' }))
  fireEvent.click(await screen.findByRole('button', { name: '重试' }))
  expect(await screen.findByText(second.translation)).toBeInTheDocument()
  expect(list.mock.calls.map(([input]) => input)).toEqual([{}, {}, { cursor }, { cursor }])
  expect(screen.queryByRole('button', { name: '加载更多' })).not.toBeInTheDocument()
})

it('renders translated headers and retains the record when deletion fails', async () => {
  vi.stubGlobal('api', {
    sentence: {
      list: vi.fn().mockResolvedValue({ status: 'ok', entries: [entry] }),
      delete: vi.fn().mockResolvedValue({ status: 'error', error: { code: 'STORAGE_FAILED' } })
    }
  })
  render(
    <I18nextProvider i18n={createI18n('en')}>
      <SentenceDetail />
    </I18nextProvider>
  )
  await screen.findByText(entry.translation)
  expect(screen.getAllByRole('columnheader').map((element) => element.textContent)).toEqual([
    'Original',
    'Translation',
    'Actions'
  ])
  fireEvent.click(screen.getByRole('button', { name: `Delete ${entry.sourceText}` }))
  fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
  await waitFor(() => expect(screen.getByRole('dialog')).toBeInTheDocument())
  expect(screen.getByText(entry.translation)).toBeInTheDocument()
})
