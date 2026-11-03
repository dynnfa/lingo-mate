import { emptyCommunicationApi } from '../../../../tests/fixtures/communication'
// @vitest-environment jsdom
import { transferApiStub } from '../recorded/vocabulary/__tests__/helpers/transfer-api'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { I18nextProvider } from 'react-i18next'
import type {
  CancelMessageResult,
  ConversationEvent,
  ConversationSummary,
  CreateConversationResult,
  GenerationStarted,
  ListConversationsResult,
  LoadConversationResult,
  LingoMateApi,
  RetryMessageInput,
  SendMessageInput
} from '../../../shared/conversation'
import type {
  PreferencesApi,
  SetUiLanguageInput,
  SetUiLanguageResult
} from '../../../shared/preferences'
import type { ModelsApi } from '../../../shared/models'
import type { UsageApi } from '../../../shared/usage'
import type { VocabularyApi } from '../../../shared/vocabulary'
import type { PhraseApi } from '../../../shared/phrase'
import type { SynonymApi } from '../../../shared/synonym'
import type { VocabularyPracticeApi } from '../../../shared/vocabulary-practice'
import type { SentencePracticeApi } from '../../../shared/sentence-practice'
import App from '../App'
import { createI18n } from '../i18n'

const SESSION_A = 'f9364f0f-f3f4-4ea6-a31d-b55754aa2477'
const SESSION_B = '0d4b2f7e-52c8-4a61-9ac1-30b1e6de9d02'
const SESSION_C = '44316d8e-c6fb-4d09-bcb8-56936a14932d'
const NOW = '2026-09-02T10:00:00.000Z'

// 测试语言显式固定为 zh-CN，不依赖开发机系统语言；
// 组件断言使用真实资源渲染的文本与可访问名称，不 mock t(key) => key。
const i18n = createI18n('zh-CN')

function renderApp(props: { initialPreferenceError?: boolean } = {}): void {
  render(
    <I18nextProvider i18n={i18n}>
      <App initialPreferenceError={props.initialPreferenceError} />
    </I18nextProvider>
  )
}

function sessionButton(sessionId: string): HTMLButtonElement {
  const button = within(screen.getByRole('navigation', { name: '会话列表' }))
    .getAllByRole('button')
    .find((item) => item.dataset.sessionId === sessionId)
  if (!(button instanceof HTMLButtonElement)) throw new Error('Session button not found')
  return button
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

function modelsApiStub(): ModelsApi {
  return {
    async listConfigs() {
      return { status: 'ok', list: { activeConfigId: null, configs: [] } }
    },
    async createConfig() {
      return { status: 'error', error: { code: 'UNKNOWN_ERROR' } }
    },
    async updateConfig() {
      return { status: 'error', error: { code: 'UNKNOWN_ERROR' } }
    },
    async deleteConfig() {
      return { status: 'error', error: { code: 'UNKNOWN_ERROR' } }
    },
    async setActiveConfig() {
      return { status: 'error', error: { code: 'UNKNOWN_ERROR' } }
    },
    async testSavedConnection() {
      return { status: 'error', error: { code: 'UNKNOWN_ERROR' } }
    },
    async testDraftConnection() {
      return { status: 'error', error: { code: 'UNKNOWN_ERROR' } }
    },
    async cancelTest() {
      return { status: 'ok' }
    }
  }
}

// App 测试不关注用量统计；提供稳定失败桩，激活 Usage 区块时不挂起。
function usageApiStub(): UsageApi {
  return {
    async getOverview() {
      return { status: 'error', error: { code: 'USAGE_READ_FAILED' } }
    }
  }
}

// App 测试不进入已记录词汇详情；提供稳定空结果桩，避免页面挂起。
function vocabularyApiStub(): VocabularyApi {
  return {
    ...transferApiStub(),
    async list() {
      return { status: 'ok', entries: [] }
    },
    async delete() {
      return { status: 'error', error: { code: 'UNKNOWN_ERROR' } }
    }
  }
}

// App 测试不进入已记录短语详情；提供稳定空结果桩，避免页面挂起。
function phraseApiStub(): PhraseApi {
  return {
    async list() {
      return { status: 'ok', entries: [] }
    },
    async delete() {
      return { status: 'error', error: { code: 'UNKNOWN_ERROR' } }
    }
  }
}

// App 测试不进入已记录近义词详情；提供稳定空结果桩，避免页面挂起。
function synonymApiStub(): SynonymApi {
  return {
    async list() {
      return { status: 'ok', groups: [], nextCursor: null }
    }
  }
}

// App 测试不进入词汇练习详情；提供稳定错误桩，避免页面挂起。
function vocabularyPracticeApiStub(): VocabularyPracticeApi {
  return {
    async start() {
      return { status: 'error', error: { code: 'UNKNOWN_ERROR' } }
    },
    async review() {
      return { status: 'error', error: { code: 'UNKNOWN_ERROR' } }
    },
    async cancel() {
      return { status: 'error', error: { code: 'UNKNOWN_ERROR' } }
    }
  }
}

// App 测试不进入造句练习详情；提供稳定错误桩，避免页面挂起。
function sentencePracticeApiStub(): SentencePracticeApi {
  return {
    async start() {
      return { status: 'error', error: { code: 'UNKNOWN_ERROR' } }
    },
    async hints() {
      return { status: 'error', error: { code: 'UNKNOWN_ERROR' } }
    },
    async review() {
      return { status: 'error', error: { code: 'UNKNOWN_ERROR' } }
    },
    async cancel() {
      return { status: 'error', error: { code: 'UNKNOWN_ERROR' } }
    },
    async close() {
      return { status: 'error', error: { code: 'UNKNOWN_ERROR' } }
    }
  }
}

function summary(sessionId: string, updatedAt: string): ConversationSummary {
  return { sessionId, title: null, createdAt: '2026-09-01T08:00:00.000Z', updatedAt }
}

interface ApiMock {
  calls: {
    create: number
    list: number
    load: string[]
    send: SendMessageInput[]
    retry: RetryMessageInput[]
    cancel: string[]
    setUiLanguage: SetUiLanguageInput[]
  }
  generations: GenerationStarted[]
  emit(event: ConversationEvent): void
  failNextSetUiLanguage(): void
}

interface ApiMockOptions {
  setUiLanguage?: (input: SetUiLanguageInput) => SetUiLanguageResult
}

function installApiMock(
  setup: {
    list?:
      | ListConversationsResult
      | Promise<ListConversationsResult>
      | (() => ListConversationsResult | Promise<ListConversationsResult>)
    startupCreate?: CreateConversationResult
    create?: CreateConversationResult | Promise<CreateConversationResult>
    load?: (sessionId: string) => LoadConversationResult | Promise<LoadConversationResult>
    send?: (
      generation: GenerationStarted
    ) => Promise<{ status: 'ok'; accepted: true; generation: GenerationStarted }>
    cancel?: (requestId: string) => CancelMessageResult | Promise<CancelMessageResult>
  } & ApiMockOptions
): ApiMock {
  const listeners = new Set<(event: ConversationEvent) => void>()
  const generations: GenerationStarted[] = []
  const userContent = new Map<string, string>()
  const mock: ApiMock = {
    calls: { create: 0, list: 0, load: [], send: [], retry: [], cancel: [], setUiLanguage: [] },
    generations,
    emit(event) {
      for (const listener of listeners) listener(event)
    },
    failNextSetUiLanguage(): void {
      failNextSetUiLanguage = true
    }
  }
  let failNextSetUiLanguage = false

  const preferences: PreferencesApi = {
    async getLanguageSettings() {
      return {
        status: 'ok',
        settings: { uiLanguage: 'system', resolvedUiLanguage: 'zh-CN', targetLanguage: 'en' }
      }
    },
    async setUiLanguage(input) {
      mock.calls.setUiLanguage.push(input)
      if (failNextSetUiLanguage) {
        failNextSetUiLanguage = false
        return { status: 'error', error: { code: 'PREFERENCES_WRITE_FAILED' } }
      }
      if (setup.setUiLanguage) return setup.setUiLanguage(input)
      const resolvedUiLanguage = input.uiLanguage === 'system' ? 'zh-CN' : input.uiLanguage
      return {
        status: 'ok',
        settings: { uiLanguage: input.uiLanguage, resolvedUiLanguage, targetLanguage: 'en' }
      }
    },
    async setTargetLanguage(input) {
      return {
        status: 'ok',
        settings: {
          uiLanguage: 'system',
          resolvedUiLanguage: 'zh-CN',
          targetLanguage: input.targetLanguage
        }
      }
    }
  }

  const api: LingoMateApi = {
    communication: emptyCommunicationApi(),
    sentence: {
      list: async () => ({ status: 'ok', entries: [] }),
      delete: async ({ id }) => ({ status: 'ok', id, deleted: false })
    },
    speech: {
      loadConversationAudio: async () => ({ status: 'error', error: { code: 'AUDIO_NOT_FOUND' } }),
      synthesize: async () => ({ status: 'error', error: { code: 'NOT_INSTALLED' } }),
      cancel: async () => ({ status: 'ok' }),
      getSettings: async () => ({ status: 'ok', settings: { voice: 'af_bella', speed: 1 } }),
      updateSettings: async (settings) => ({ status: 'ok', settings }),
      getRuntimeStatus: async () => ({
        status: 'ok',
        runtime: { phase: 'not-installed', progress: 0 }
      }),
      installResources: async () => ({ status: 'ok' }),
      cancelInstall: async () => ({ status: 'ok' }),
      onStatus: () => () => {}
    },
    preferences,
    // App 测试不触发错误上报；提供静默桩满足接口形状。
    reportError: async () => ({ status: 'ok' }),
    // App 测试不关注模型设置；提供未配置的稳定桩供 Settings 页读取。
    models: modelsApiStub(),
    usage: usageApiStub(),
    vocabulary: vocabularyApiStub(),
    phrase: phraseApiStub(),
    synonym: synonymApiStub(),
    vocabularyPractice: vocabularyPracticeApiStub(),
    sentencePractice: sentencePracticeApiStub(),
    // App 测试不进入错题集详情；提供稳定空结果桩，避免页面挂起。
    vocabularyMistakes: {
      async list() {
        return { status: 'ok', entries: [] }
      },
      async listHistory() {
        return { status: 'error', error: { code: 'UNKNOWN_ERROR' } }
      }
    },
    conversation: {
      async create() {
        mock.calls.create += 1
        if (mock.calls.create === 1) {
          return setup.startupCreate ?? { status: 'ok', conversation: summary(SESSION_A, NOW) }
        }
        return setup.create ?? { status: 'error', error: { code: 'UNKNOWN_ERROR' } }
      },
      async list() {
        mock.calls.list += 1
        if (typeof setup.list === 'function') return setup.list()
        if (setup.list) return setup.list
        throw new Error('list not configured')
      },
      async load(input) {
        mock.calls.load.push(input.sessionId)
        return (
          setup.load?.(input.sessionId) ?? {
            status: 'error',
            error: { code: 'NOT_FOUND', resource: 'conversation' }
          }
        )
      },
      async send(input) {
        mock.calls.send.push(input)
        const generation: GenerationStarted = {
          requestId: input.requestId,
          sessionId: input.sessionId,
          userMessage: {
            messageId: crypto.randomUUID(),
            sessionId: input.sessionId,
            role: 'user',
            content: input.text,
            createdAt: NOW
          },
          assistantMessageId: crypto.randomUUID()
        }
        generations.push(generation)
        userContent.set(generation.userMessage.messageId, input.text)
        const fallback = { status: 'ok' as const, accepted: true as const, generation }
        return setup.send?.(generation) ?? fallback
      },
      async runSkill() {
        return { status: 'error', error: { code: 'INVALID_INPUT' } }
      },
      async retry(input) {
        mock.calls.retry.push(input)
        const generation: GenerationStarted = {
          requestId: input.requestId,
          sessionId: input.sessionId,
          userMessage: {
            messageId: input.userMessageId,
            sessionId: input.sessionId,
            role: 'user',
            content: userContent.get(input.userMessageId) ?? '',
            createdAt: NOW
          },
          assistantMessageId: crypto.randomUUID()
        }
        generations.push(generation)
        return { status: 'ok', accepted: true, generation }
      },
      async cancel(input) {
        mock.calls.cancel.push(input.requestId)
        return setup.cancel?.(input.requestId) ?? { status: 'ok' }
      },
      onEvent(listener) {
        listeners.add(listener)
        return () => listeners.delete(listener)
      }
    }
  }

  vi.stubGlobal('api', api)
  return mock
}

async function renderReady(mock: ApiMock): Promise<void> {
  renderApp()
  await waitFor(() => {
    expect(document.querySelector('main')?.getAttribute('data-phase')).toBe('ready')
  })
  void mock
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  void i18n.changeLanguage('zh-CN')
})

describe('App conversation recovery', () => {
  it('starts with a blank draft and opens history only when selected', async () => {
    const mock = installApiMock({
      startupCreate: { status: 'ok', conversation: summary(SESSION_C, NOW) },
      list: {
        status: 'ok',
        conversations: [
          summary(SESSION_A, '2026-09-02T10:00:00.000Z'),
          summary(SESSION_B, '2026-09-01T10:00:00.000Z')
        ]
      },
      load: (sessionId) =>
        sessionId === SESSION_A
          ? {
              status: 'ok',
              conversation: summary(SESSION_A, '2026-09-02T10:00:00.000Z'),
              messages: [
                {
                  messageId: '3f70b8ae-7ad9-4eab-aaf4-1cae54a99708',
                  sessionId: SESSION_A,
                  role: 'user',
                  content: 'Hello',
                  createdAt: '2026-09-02T09:59:00.000Z'
                },
                {
                  messageId: '6a9ee8b8-83aa-4b52-8d5a-91f0a48e26f5',
                  sessionId: SESSION_A,
                  role: 'assistant',
                  content: 'Hi there',
                  createdAt: '2026-09-02T10:00:00.000Z'
                }
              ]
            }
          : { status: 'ok', conversation: summary(sessionId, NOW), messages: [] }
    })

    renderApp()

    await waitFor(() => {
      expect(document.querySelector('main')?.getAttribute('data-phase')).toBe('ready')
    })

    expect(mock.calls.create).toBe(1)
    expect(mock.calls.load).toEqual([SESSION_C])
    expect(screen.getByText('从一句话开始')).toBeInTheDocument()
    expect(screen.getByLabelText('练习内容')).toHaveFocus()
    expect(screen.queryByText('Hello')).not.toBeInTheDocument()
    expect(sessionButton(SESSION_A)).toHaveAttribute('aria-pressed', 'false')
    expect(sessionButton(SESSION_B)).toHaveAttribute('aria-pressed', 'false')
    expect(document.querySelector(`[data-session-id="${SESSION_C}"]`)).toBeNull()

    fireEvent.click(sessionButton(SESSION_A))
    expect(await screen.findByText('Hello')).toBeInTheDocument()
    expect(screen.getByText('Hi there')).toBeInTheDocument()
    expect(sessionButton(SESSION_A)).toHaveAttribute('aria-pressed', 'true')
    expect(document.querySelector('.message.assistant')?.getAttribute('data-message-id')).toBe(
      '6a9ee8b8-83aa-4b52-8d5a-91f0a48e26f5'
    )
  })

  it('creates a conversation when the database is empty', async () => {
    const mock = installApiMock({
      list: { status: 'ok', conversations: [] },
      create: {
        status: 'ok',
        conversation: summary(SESSION_A, '2026-09-03T10:00:00.000Z')
      },
      load: (sessionId) => ({
        status: 'ok',
        conversation: summary(sessionId, '2026-09-03T10:00:00.000Z'),
        messages: []
      })
    })

    renderApp()

    expect(await screen.findByText('从一句话开始')).toBeInTheDocument()
    expect(mock.calls.create).toBe(1)
    expect(mock.calls.load).toEqual([SESSION_A])
    expect(screen.getByLabelText('练习内容')).toBeEnabled()
    expect(screen.getByLabelText('练习内容')).toHaveFocus()
  })

  it('shows a generated title in the conversation list', async () => {
    const mock = installApiMock({
      list: {
        status: 'ok',
        conversations: [{ ...summary(SESSION_A, NOW), title: '咖啡店英语练习' }]
      },
      load: () => ({
        status: 'ok',
        conversation: { ...summary(SESSION_A, NOW), title: '咖啡店英语练习' },
        messages: []
      })
    })
    await renderReady(mock)
    expect(sessionButton(SESSION_A)).toHaveTextContent('咖啡店英语练习')
  })

  it('labels conversation entries with a locale-formatted date', async () => {
    installApiMock({
      list: { status: 'ok', conversations: [summary(SESSION_A, '2026-09-02T10:00:00.000Z')] },
      load: (sessionId) => ({
        status: 'ok',
        conversation: summary(sessionId, NOW),
        messages: []
      })
    })

    renderApp()
    await waitFor(() => {
      expect(document.querySelector('main')?.getAttribute('data-phase')).toBe('ready')
    })

    expect(sessionButton(SESSION_A).textContent).toMatch(/^会话 · /)
    expect(sessionButton(SESSION_A).textContent).toContain('2026')
  })

  it('blocks sending while startup recovery has not finished', async () => {
    installApiMock({ list: new Promise(() => undefined) })

    renderApp()

    expect(document.querySelector('main')?.getAttribute('data-phase')).toBe('loading')
    expect(screen.getByLabelText('练习内容')).toBeDisabled()
    expect(screen.getByRole('button', { name: '发送' })).toBeDisabled()
  })

  it('shows a failed state and keeps the composer locked when recovery fails', async () => {
    installApiMock({
      list: { status: 'error', error: { code: 'PERSISTENCE_ERROR' } }
    })

    renderApp()

    expect(await screen.findByText('访问本地会话数据失败，请稍后重试。')).toBeInTheDocument()
    expect(document.querySelector('main')?.getAttribute('data-phase')).toBe('failed')
    expect(screen.getByLabelText('练习内容')).toBeDisabled()
    expect(screen.getByRole('button', { name: '发送' })).toBeDisabled()
  })

  it('handles a rejected recovery call without leaving the UI loading', async () => {
    installApiMock({ list: Promise.reject(new Error('ipc unavailable')) })

    renderApp()

    expect(await screen.findByText('无法加载会话，请稍后重试。')).toBeInTheDocument()
    expect(document.querySelector('main')?.getAttribute('data-phase')).toBe('failed')
    expect(screen.getByLabelText('练习内容')).toBeDisabled()
  })
})

describe('App message lifecycle', () => {
  const loadedEmpty = (sessionId: string): LoadConversationResult => ({
    status: 'ok',
    conversation: summary(sessionId, '2026-09-02T10:00:00.000Z'),
    messages: []
  })

  async function submitMessage(text: string): Promise<void> {
    fireEvent.change(screen.getByLabelText('练习内容'), { target: { value: text } })
    fireEvent.click(screen.getByRole('button', { name: '发送' }))
  }

  it('renders one assistant element under the canonical messageId from first paint to completion', async () => {
    const mock = installApiMock({
      list: { status: 'ok', conversations: [summary(SESSION_A, NOW)] },
      load: () => loadedEmpty(SESSION_A)
    })
    await renderReady(mock)

    await submitMessage('Hello')
    const generation = await waitFor(() => mock.generations[0])

    // send 结果到达后：user 与 assistant draft 首次出现即使用 canonical messageId
    await waitFor(() => {
      expect(
        document.querySelector(`[data-message-id="${generation.assistantMessageId}"]`)
      ).toBeInTheDocument()
    })
    expect(document.querySelectorAll('.message')).toHaveLength(2)

    mock.emit({ type: 'started', ...generation })
    mock.emit({
      type: 'chunk',
      requestId: generation.requestId,
      sessionId: SESSION_A,
      messageId: generation.assistantMessageId,
      delta: 'Hi'
    })
    expect(await screen.findByText('Hi')).toBeInTheDocument()

    mock.emit({
      type: 'completed',
      requestId: generation.requestId,
      sessionId: SESSION_A,
      message: {
        messageId: generation.assistantMessageId,
        sessionId: SESSION_A,
        role: 'assistant',
        content: 'Hi there',
        createdAt: NOW
      }
    })

    expect(await screen.findByText('Hi there')).toBeInTheDocument()
    // completed 原位对账：不产生第二条 assistant，key 仍是同一个 canonical id
    expect(document.querySelectorAll('.message.assistant')).toHaveLength(1)
    expect(document.querySelector('.message.assistant')?.getAttribute('data-message-id')).toBe(
      generation.assistantMessageId
    )
    expect(await screen.findByText('回复完成')).toBeInTheDocument()
    expect(screen.getByLabelText('练习内容')).toBeEnabled()
  })

  it('merges a started event that arrives before the send result without duplicating messages', async () => {
    const pendingSend = deferred<{
      status: 'ok'
      accepted: true
      generation: GenerationStarted
    }>()
    const mock = installApiMock({
      list: { status: 'ok', conversations: [summary(SESSION_A, NOW)] },
      load: () => loadedEmpty(SESSION_A),
      send: (generation) => {
        void generation
        return pendingSend.promise
      }
    })
    await renderReady(mock)

    await submitMessage('Hello')
    await waitFor(() => expect(mock.calls.send).toHaveLength(1))

    // started 事件先于 send 结果到达
    mock.emit({ type: 'started', ...mock.generations[0] })
    await waitFor(() => {
      expect(document.querySelectorAll('.message')).toHaveLength(2)
    })

    pendingSend.resolve({ status: 'ok', accepted: true, generation: mock.generations[0] })
    await waitFor(() => {
      expect(screen.getByRole('button', { name: '取消' })).toBeInTheDocument()
    })

    // 幂等归并：仍只有一条 user 和一条 assistant
    expect(document.querySelectorAll('.message')).toHaveLength(2)
  })

  it('removes the partial draft and offers retry when the generation is cancelled', async () => {
    const mock = installApiMock({
      list: { status: 'ok', conversations: [summary(SESSION_A, NOW)] },
      load: () => loadedEmpty(SESSION_A)
    })
    await renderReady(mock)

    await submitMessage('Hello')
    const generation = await waitFor(() => mock.generations[0])
    mock.emit({ type: 'started', ...generation })
    mock.emit({
      type: 'chunk',
      requestId: generation.requestId,
      sessionId: SESSION_A,
      messageId: generation.assistantMessageId,
      delta: 'partial'
    })
    expect(await screen.findByText('partial')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    expect(mock.calls.cancel).toEqual([generation.requestId])

    mock.emit({
      type: 'cancelled',
      requestId: generation.requestId,
      sessionId: SESSION_A,
      messageId: generation.assistantMessageId
    })

    expect(await screen.findByText('已取消，可重试。')).toBeInTheDocument()
    // 部分草稿被删除，只保留 user，并标记可重试
    expect(document.querySelectorAll('.message')).toHaveLength(1)
    expect(screen.getByText('Hello')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '重试' }))
    await waitFor(() => expect(mock.calls.retry).toHaveLength(1))
    expect(mock.calls.retry[0]).toMatchObject({
      sessionId: SESSION_A,
      userMessageId: generation.userMessage.messageId
    })

    const retryGeneration = await waitFor(() => mock.generations[1])
    expect(retryGeneration.userMessage.messageId).toBe(generation.userMessage.messageId)
    expect(retryGeneration.assistantMessageId).not.toBe(generation.assistantMessageId)

    mock.emit({ type: 'started', ...retryGeneration })
    mock.emit({
      type: 'completed',
      requestId: retryGeneration.requestId,
      sessionId: SESSION_A,
      message: {
        messageId: retryGeneration.assistantMessageId,
        sessionId: SESSION_A,
        role: 'assistant',
        content: 'Retry reply',
        createdAt: NOW
      }
    })

    expect(await screen.findByText('Retry reply')).toBeInTheDocument()
    // 不重复 user；assistant 使用新的 canonical ID
    expect(document.querySelectorAll('.message.user')).toHaveLength(1)
    expect(document.querySelectorAll('.message.assistant')).toHaveLength(1)
    expect(document.querySelector('.message.assistant')?.getAttribute('data-message-id')).toBe(
      retryGeneration.assistantMessageId
    )
  })

  it('drops the draft and shows the safe error when the model fails after chunks', async () => {
    const mock = installApiMock({
      list: { status: 'ok', conversations: [summary(SESSION_A, NOW)] },
      load: () => loadedEmpty(SESSION_A)
    })
    await renderReady(mock)

    await submitMessage('Hello')
    const generation = await waitFor(() => mock.generations[0])
    mock.emit({ type: 'started', ...generation })
    mock.emit({
      type: 'chunk',
      requestId: generation.requestId,
      sessionId: SESSION_A,
      messageId: generation.assistantMessageId,
      delta: 'partial'
    })
    expect(await screen.findByText('partial')).toBeInTheDocument()

    mock.emit({
      type: 'failed',
      requestId: generation.requestId,
      sessionId: SESSION_A,
      messageId: generation.assistantMessageId,
      error: { code: 'MODEL_ERROR' }
    })

    expect(await screen.findByText('生成回复失败，请稍后重试。')).toBeInTheDocument()
    expect(document.querySelectorAll('.message')).toHaveLength(1)
    expect(screen.getByText('Hello')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '重试' })).toBeInTheDocument()
    expect(screen.getByLabelText('练习内容')).toBeEnabled()
  })

  it('marks the last unanswered user message retryable after loading history', async () => {
    installApiMock({
      list: { status: 'ok', conversations: [summary(SESSION_A, NOW)] },
      load: () => ({
        status: 'ok',
        conversation: summary(SESSION_A, NOW),
        messages: [
          {
            messageId: '3f70b8ae-7ad9-4eab-aaf4-1cae54a99708',
            sessionId: SESSION_A,
            role: 'user',
            content: 'Unanswered',
            createdAt: NOW
          }
        ]
      })
    })

    renderApp()
    await waitFor(() => {
      expect(document.querySelector('main')?.getAttribute('data-phase')).toBe('ready')
    })

    expect(await screen.findByText('Unanswered')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '重试' })).toBeInTheDocument()
  })
})

describe('App conversation switching', () => {
  it('blocks session transitions until a pending send returns its canonical generation', async () => {
    const pendingSend = deferred<{
      status: 'ok'
      accepted: true
      generation: GenerationStarted
    }>()
    const mock = installApiMock({
      list: {
        status: 'ok',
        conversations: [summary(SESSION_A, NOW), summary(SESSION_B, NOW)]
      },
      load: (sessionId) => ({
        status: 'ok',
        conversation: summary(sessionId, NOW),
        messages: []
      }),
      send: () => pendingSend.promise
    })
    await renderReady(mock)

    fireEvent.change(screen.getByLabelText('练习内容'), { target: { value: 'Hello' } })
    fireEvent.click(screen.getByRole('button', { name: '发送' }))
    await waitFor(() => expect(mock.calls.send).toHaveLength(1))

    expect(sessionButton(SESSION_B)).toBeDisabled()
    expect(screen.getByRole('button', { name: '新会话' })).toBeDisabled()

    pendingSend.resolve({ status: 'ok', accepted: true, generation: mock.generations[0] })
    await waitFor(() => expect(sessionButton(SESSION_B)).toBeEnabled())
  })

  it('keeps the current session and request tracking when transition cancellation fails', async () => {
    const mock = installApiMock({
      list: {
        status: 'ok',
        conversations: [summary(SESSION_A, NOW), summary(SESSION_B, NOW)]
      },
      load: (sessionId) => ({
        status: 'ok',
        conversation: summary(sessionId, NOW),
        messages: []
      }),
      cancel: () => ({
        status: 'error',
        error: { code: 'REQUEST_NOT_FOUND' }
      })
    })
    await renderReady(mock)

    fireEvent.change(screen.getByLabelText('练习内容'), { target: { value: 'Hello' } })
    fireEvent.click(screen.getByRole('button', { name: '发送' }))
    const generation = await waitFor(() => mock.generations[0])
    await waitFor(() => expect(screen.getByRole('button', { name: '取消' })).toBeInTheDocument())

    fireEvent.click(sessionButton(SESSION_B))

    expect(await screen.findByText('没有找到进行中的回复请求。')).toBeInTheDocument()
    expect(sessionButton(SESSION_A)).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: '取消' })).toBeInTheDocument()
    expect(mock.calls.cancel).toEqual([generation.requestId])
    expect(mock.calls.load).not.toContain(SESSION_B)
  })

  it('cancels the active request and ignores stale events when switching conversations', async () => {
    const mock = installApiMock({
      list: {
        status: 'ok',
        conversations: [
          summary(SESSION_A, '2026-09-02T10:00:00.000Z'),
          summary(SESSION_B, '2026-09-01T10:00:00.000Z')
        ]
      },
      load: (sessionId) => ({
        status: 'ok',
        conversation: summary(sessionId, '2026-09-01T10:00:00.000Z'),
        messages:
          sessionId === SESSION_B
            ? [
                {
                  messageId: '6a9ee8b8-83aa-4b52-8d5a-91f0a48e26f5',
                  sessionId: SESSION_B,
                  role: 'assistant',
                  content: 'Bonjour 的历史回复',
                  createdAt: '2026-09-01T10:00:00.000Z'
                }
              ]
            : []
      })
    })

    renderApp()
    await waitFor(() => {
      expect(document.querySelector('main')?.getAttribute('data-phase')).toBe('ready')
    })

    fireEvent.change(screen.getByLabelText('练习内容'), { target: { value: 'Hello' } })
    fireEvent.click(screen.getByRole('button', { name: '发送' }))

    const generation = await waitFor(() => mock.generations[0])
    expect(mock.calls.send[0].sessionId).toBe(SESSION_A)

    // 生成进行中，切换到会话 B
    fireEvent.click(sessionButton(SESSION_B))

    await waitFor(() => {
      expect(screen.getByText('Bonjour 的历史回复')).toBeInTheDocument()
    })
    expect(mock.calls.cancel).toEqual([generation.requestId])

    // 旧会话的流式事件不得写入新会话视图
    mock.emit({
      type: 'chunk',
      requestId: generation.requestId,
      sessionId: SESSION_A,
      messageId: generation.assistantMessageId,
      delta: 'stale'
    })
    expect(screen.queryByText(/stale/)).not.toBeInTheDocument()
    expect(screen.getByText('Bonjour 的历史回复')).toBeInTheDocument()
  })

  it('locks sidebar and composer while loading the selected conversation', async () => {
    const loadB = deferred<LoadConversationResult>()
    const mock = installApiMock({
      list: {
        status: 'ok',
        conversations: [summary(SESSION_A, NOW), summary(SESSION_B, NOW), summary(SESSION_C, NOW)]
      },
      load: (sessionId) =>
        sessionId === SESSION_B
          ? loadB.promise
          : {
              status: 'ok',
              conversation: summary(sessionId, NOW),
              messages: []
            }
    })
    await renderReady(mock)
    fireEvent.click(sessionButton(SESSION_B))
    await waitFor(() => expect(mock.calls.load).toContain(SESSION_B))
    expect(sessionButton(SESSION_C)).toBeDisabled()
    expect(screen.getByRole('button', { name: '新会话' })).toBeDisabled()
    expect(screen.getByLabelText('练习内容')).toBeDisabled()
    fireEvent.click(sessionButton(SESSION_C))
    expect(mock.calls.load).not.toContain(SESSION_C)

    loadB.resolve({
      status: 'ok',
      conversation: summary(SESSION_B, NOW),
      messages: [
        {
          messageId: '7b097553-e4fb-48c9-be81-e25cfa55358e',
          sessionId: SESSION_B,
          role: 'assistant',
          content: '选中的会话',
          createdAt: NOW
        }
      ]
    })
    expect(await screen.findByText('选中的会话')).toBeInTheDocument()
    expect(sessionButton(SESSION_B)).toHaveAttribute('aria-pressed', 'true')
    expect(sessionButton(SESSION_A)).toHaveAttribute('aria-pressed', 'false')
    expect(sessionButton(SESSION_C)).toBeEnabled()
    expect(screen.getByLabelText('练习内容')).toBeEnabled()
  })

  it('creates and selects a new conversation from the sidebar', async () => {
    const mock = installApiMock({
      list: { status: 'ok', conversations: [summary(SESSION_A, NOW)] },
      create: { status: 'ok', conversation: summary(SESSION_B, NOW) },
      load: (sessionId) => ({
        status: 'ok',
        conversation: summary(sessionId, NOW),
        messages: []
      })
    })
    await renderReady(mock)
    fireEvent.click(
      within(screen.getByRole('complementary', { name: '会话侧栏' })).getByRole('button', {
        name: '新会话'
      })
    )
    await waitFor(() => expect(mock.calls.load).toContain(SESSION_B))
    expect(document.querySelector(`[data-session-id="${SESSION_B}"]`)).toBeNull()
    expect(mock.calls.create).toBe(2)
    expect(mock.calls.load).toEqual([SESSION_A, SESSION_B])
    expect(sessionButton(SESSION_A)).toHaveAttribute('aria-pressed', 'false')
    expect(
      within(screen.getByRole('region', { name: '对话记录' })).getByText('从一句话开始')
    ).toBeInTheDocument()
    await waitFor(() => expect(screen.getByLabelText('练习内容')).toHaveFocus())
  })

  it('keeps an unsent draft when switching to another conversation', async () => {
    const mock = installApiMock({
      list: { status: 'ok', conversations: [summary(SESSION_A, NOW), summary(SESSION_B, NOW)] },
      load: (sessionId) => ({
        status: 'ok',
        conversation: summary(sessionId, NOW),
        messages: []
      })
    })
    await renderReady(mock)

    fireEvent.change(screen.getByLabelText('练习内容'), { target: { value: 'unsent draft' } })
    fireEvent.click(sessionButton(SESSION_B))
    await waitFor(() => expect(sessionButton(SESSION_B)).toHaveAttribute('aria-pressed', 'true'))

    // 草稿归面板所有，稳定挂载下切换会话不清空未发送内容
    expect(screen.getByLabelText('练习内容')).toHaveValue('unsent draft')
  })

  it('keeps an unsent draft when creating a new conversation', async () => {
    const mock = installApiMock({
      list: { status: 'ok', conversations: [summary(SESSION_A, NOW)] },
      create: { status: 'ok', conversation: summary(SESSION_B, NOW) },
      load: (sessionId) => ({
        status: 'ok',
        conversation: summary(sessionId, NOW),
        messages: []
      })
    })
    await renderReady(mock)

    fireEvent.change(screen.getByLabelText('练习内容'), { target: { value: 'unsent draft' } })
    fireEvent.click(screen.getByRole('button', { name: '新会话' }))
    await waitFor(() => expect(mock.calls.load).toContain(SESSION_B))
    expect(document.querySelector(`[data-session-id="${SESSION_B}"]`)).toBeNull()

    expect(screen.getByLabelText('练习内容')).toHaveValue('unsent draft')
  })

  it('ignores terminal events from an invalidated request after returning to its session', async () => {
    const mock = installApiMock({
      list: {
        status: 'ok',
        conversations: [
          summary(SESSION_A, '2026-09-02T10:00:00.000Z'),
          summary(SESSION_B, '2026-09-01T10:00:00.000Z')
        ]
      },
      load: (sessionId) => ({
        status: 'ok',
        conversation: summary(sessionId, '2026-09-02T10:00:00.000Z'),
        messages: []
      })
    })

    renderApp()
    await waitFor(() => {
      expect(document.querySelector('main')?.getAttribute('data-phase')).toBe('ready')
    })

    fireEvent.change(screen.getByLabelText('练习内容'), { target: { value: 'first' } })
    fireEvent.click(screen.getByRole('button', { name: '发送' }))
    const firstGeneration = await waitFor(() => mock.generations[0])

    fireEvent.click(sessionButton(SESSION_B))
    await waitFor(() => expect(sessionButton(SESSION_B)).toHaveAttribute('aria-pressed', 'true'))
    fireEvent.click(sessionButton(SESSION_A))
    await waitFor(() => expect(sessionButton(SESSION_A)).toHaveAttribute('aria-pressed', 'true'))

    fireEvent.change(screen.getByLabelText('练习内容'), { target: { value: 'second' } })
    fireEvent.click(screen.getByRole('button', { name: '发送' }))
    const secondGeneration = await waitFor(() => mock.generations[1])

    // 旧请求的终态不得影响当前生成
    mock.emit({
      type: 'completed',
      requestId: firstGeneration.requestId,
      sessionId: SESSION_A,
      message: {
        messageId: firstGeneration.assistantMessageId,
        sessionId: SESSION_A,
        role: 'assistant',
        content: 'stale reply',
        createdAt: NOW
      }
    })
    expect(screen.getByRole('button', { name: '取消' })).toBeInTheDocument()
    expect(screen.queryByText('stale reply')).not.toBeInTheDocument()

    mock.emit({
      type: 'chunk',
      requestId: secondGeneration.requestId,
      sessionId: SESSION_A,
      messageId: secondGeneration.assistantMessageId,
      delta: 'current reply'
    })
    expect(await screen.findByText('current reply')).toBeInTheDocument()
  })

  it.each([
    {
      name: 'structured error',
      failure: () =>
        ({
          status: 'error',
          error: { code: 'PERSISTENCE_ERROR' }
        }) satisfies ListConversationsResult,
      expected: '访问本地会话数据失败，请稍后重试。'
    },
    {
      name: 'rejected call',
      failure: () => Promise.reject(new Error('ipc unavailable')),
      expected: '无法刷新会话列表，请稍后重试。'
    }
  ])('reports a $name while preserving the current conversation', async ({ failure, expected }) => {
    let listCall = 0
    const mock = installApiMock({
      list: () => {
        listCall += 1
        return listCall === 1
          ? {
              status: 'ok',
              conversations: [summary(SESSION_A, '2026-09-02T10:00:00.000Z')]
            }
          : failure()
      },
      load: () => ({
        status: 'ok',
        conversation: summary(SESSION_A, '2026-09-02T10:00:00.000Z'),
        messages: []
      })
    })

    renderApp()
    await waitFor(() => {
      expect(document.querySelector('main')?.getAttribute('data-phase')).toBe('ready')
    })

    fireEvent.change(screen.getByLabelText('练习内容'), { target: { value: 'hello' } })
    fireEvent.click(screen.getByRole('button', { name: '发送' }))
    const generation = await waitFor(() => mock.generations[0])

    mock.emit({
      type: 'completed',
      requestId: generation.requestId,
      sessionId: SESSION_A,
      message: {
        messageId: generation.assistantMessageId,
        sessionId: SESSION_A,
        role: 'assistant',
        content: 'Hi',
        createdAt: NOW
      }
    })

    expect(await screen.findByText(expected)).toBeInTheDocument()
    expect(document.querySelector('main')?.getAttribute('data-phase')).toBe('ready')
    expect(sessionButton(SESSION_A)).toHaveAttribute('aria-pressed', 'true')
  })
})

describe('App language settings', () => {
  it('switches the interface language at runtime without losing drafts or remounting state', async () => {
    const mock = installApiMock({
      list: { status: 'ok', conversations: [summary(SESSION_A, NOW)] },
      load: () => ({
        status: 'ok',
        conversation: summary(SESSION_A, NOW),
        messages: []
      })
    })
    await renderReady(mock)

    fireEvent.change(screen.getByLabelText('练习内容'), { target: { value: 'kept draft' } })
    fireEvent.click(screen.getByRole('button', { name: '设置' }))

    // 设置页替换对话视图：界面语言区块可见，对话视图隐藏但保持挂载
    expect(screen.getByRole('heading', { name: '界面语言' })).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: '跟随系统 / System' })).toBeChecked()
    expect(screen.getByRole('button', { name: '发送', hidden: true })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('radio', { name: 'English' }))

    // 保存成功后按返回的 resolvedUiLanguage 切换界面语言
    await waitFor(() => {
      expect(mock.calls.setUiLanguage).toEqual([{ uiLanguage: 'en' }])
    })
    expect(await screen.findByRole('button', { name: 'Back' })).toBeInTheDocument()

    // 草稿保留、会话与数据不受影响；已有终态提示立即换语言
    expect(screen.getByLabelText('Practice text')).toHaveValue('kept draft')
    expect(screen.getByText('Ready')).toBeInTheDocument()
    const englishSessionTitle = document.querySelector(`[data-session-id="${SESSION_A}"]`)
    expect(englishSessionTitle?.textContent).toMatch(/^Conversation · /)
    expect(document.querySelectorAll('.message')).toHaveLength(0)

    // 返回对话视图后设置页卸载，焦点回到设置按钮，草稿仍在
    fireEvent.click(screen.getByRole('button', { name: 'Back' }))
    expect(screen.queryByRole('radio', { name: 'English' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Settings' })).toHaveFocus()
    expect(screen.getByLabelText('Practice text')).toHaveValue('kept draft')
  })

  it('exits the settings page with Escape and restores focus', async () => {
    const mock = installApiMock({
      list: { status: 'ok', conversations: [summary(SESSION_A, NOW)] },
      load: () => ({
        status: 'ok',
        conversation: summary(SESSION_A, NOW),
        messages: []
      })
    })
    await renderReady(mock)

    fireEvent.click(screen.getByRole('button', { name: '设置' }))
    fireEvent.keyDown(screen.getByRole('main', { name: '设置' }), { key: 'Escape' })

    expect(screen.queryByRole('radio', { name: 'English' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '设置' })).toHaveFocus()
  })

  it('keeps the previous language and reports a failure when saving fails', async () => {
    const mock = installApiMock({
      list: { status: 'ok', conversations: [summary(SESSION_A, NOW)] },
      load: () => ({
        status: 'ok',
        conversation: summary(SESSION_A, NOW),
        messages: []
      })
    })
    mock.failNextSetUiLanguage()
    await renderReady(mock)

    fireEvent.click(screen.getByRole('button', { name: '设置' }))
    fireEvent.click(screen.getByRole('radio', { name: 'English' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('保存语言设置失败，请重试。')
    // 保存失败保留原语言与原选择，对话视图仍可返回
    expect(screen.getByRole('button', { name: '发送', hidden: true })).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: '跟随系统 / System' })).toBeChecked()
    expect(screen.getByRole('radio', { name: 'English' })).not.toBeChecked()
  })

  it('shows a dismissible notice when the startup preference could not be loaded', async () => {
    installApiMock({
      list: { status: 'ok', conversations: [summary(SESSION_A, NOW)] },
      load: () => ({
        status: 'ok',
        conversation: summary(SESSION_A, NOW),
        messages: []
      })
    })

    renderApp({ initialPreferenceError: true })

    expect(await screen.findByRole('alert')).toHaveTextContent('无法读取语言偏好，已使用默认语言。')
    fireEvent.click(screen.getByRole('button', { name: '知道了' }))
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })
})

describe('App recorded page navigation', () => {
  const loadedWithHistory = (sessionId: string): LoadConversationResult => ({
    status: 'ok',
    conversation: summary(sessionId, NOW),
    messages: [
      {
        messageId: '3f70a8ae-7ad9-4eab-aaf4-1cae54a99708',
        sessionId,
        role: 'user',
        content: 'Hello',
        createdAt: NOW
      }
    ]
  })

  it('opens the recorded page, hides the conversation view and restores focus on exit', async () => {
    const mock = installApiMock({
      list: { status: 'ok', conversations: [summary(SESSION_A, NOW)] },
      load: () => loadedWithHistory(SESSION_A)
    })
    await renderReady(mock)
    expect(await screen.findByText('Hello')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '已记录词汇' }))

    // 已记录页替换对话视图；对话视图保持挂载但隐藏
    expect(screen.getByRole('main', { name: '已记录词汇' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '返回' })).toHaveFocus()
    expect(document.querySelector('.chat-shell')).toHaveAttribute('hidden')
    expect(screen.getByLabelText('练习内容')).not.toBeVisible()

    fireEvent.click(screen.getByRole('button', { name: '返回' }))

    expect(screen.queryByRole('main', { name: '已记录词汇' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '已记录词汇' })).toHaveFocus()
    expect(screen.getByLabelText('练习内容')).toBeVisible()
  })

  it('exits the recorded page with Escape', async () => {
    const mock = installApiMock({
      list: { status: 'ok', conversations: [summary(SESSION_A, NOW)] },
      load: () => loadedWithHistory(SESSION_A)
    })
    await renderReady(mock)

    fireEvent.click(screen.getByRole('button', { name: '已记录词汇' }))
    fireEvent.keyDown(screen.getByRole('main', { name: '已记录词汇' }), { key: 'Escape' })

    expect(screen.queryByRole('main', { name: '已记录词汇' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '已记录词汇' })).toHaveFocus()
  })

  it('opens the mistakes page from the menu and restores focus on exit', async () => {
    const mock = installApiMock({
      list: { status: 'ok', conversations: [summary(SESSION_A, NOW)] },
      load: () => loadedWithHistory(SESSION_A)
    })
    await renderReady(mock)
    expect(await screen.findByText('Hello')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '错题集' }))

    // 错题集页替换对话视图；空列表展示空态，对话视图保持挂载但隐藏
    expect(screen.getByRole('main', { name: '错题集' })).toBeInTheDocument()
    expect(await screen.findByText('还没有错题')).toBeInTheDocument()
    expect(document.querySelector('.chat-shell')).toHaveAttribute('hidden')

    fireEvent.click(screen.getByRole('button', { name: '返回' }))

    expect(screen.queryByRole('main', { name: '错题集' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '错题集' })).toHaveFocus()
    expect(screen.getByLabelText('练习内容')).toBeVisible()
  })

  it('keeps the conversation, history and unsent draft across a recorded page round trip', async () => {
    const mock = installApiMock({
      list: { status: 'ok', conversations: [summary(SESSION_A, NOW)] },
      load: () => loadedWithHistory(SESSION_A)
    })
    await renderReady(mock)
    fireEvent.change(screen.getByLabelText('练习内容'), { target: { value: 'unsent draft' } })

    fireEvent.click(screen.getByRole('button', { name: '已记录词汇' }))
    fireEvent.click(screen.getByRole('button', { name: '返回' }))

    expect(await screen.findByText('Hello')).toBeInTheDocument()
    expect(screen.getByLabelText('练习内容')).toHaveValue('unsent draft')
    expect(sessionButton(SESSION_A)).toHaveAttribute('aria-pressed', 'true')
    // 骨架阶段不发起任何词汇数据请求，也不重复读取会话
    expect(mock.calls.list).toBe(1)
    expect(mock.calls.load).toEqual([SESSION_A])
  })

  it('does not reload data when the entry is clicked repeatedly', async () => {
    const mock = installApiMock({
      list: { status: 'ok', conversations: [summary(SESSION_A, NOW)] },
      load: () => loadedWithHistory(SESSION_A)
    })
    await renderReady(mock)

    fireEvent.click(screen.getByRole('button', { name: '已记录词汇' }))
    // 已记录页打开期间侧栏入口处于隐藏视图内，需要显式包含隐藏元素
    fireEvent.click(screen.getByRole('button', { name: '已记录词汇', hidden: true }))

    expect(screen.getByRole('main', { name: '已记录词汇' })).toBeInTheDocument()
    expect(mock.calls.list).toBe(1)
    expect(mock.calls.load).toEqual([SESSION_A])
  })

  it('keeps settings navigation restoring focus to its own entry', async () => {
    const mock = installApiMock({
      list: { status: 'ok', conversations: [summary(SESSION_A, NOW)] },
      load: () => loadedWithHistory(SESSION_A)
    })
    await renderReady(mock)

    // 已记录与设置两个入口的焦点恢复互不干扰
    fireEvent.click(screen.getByRole('button', { name: '已记录词汇' }))
    fireEvent.click(screen.getByRole('button', { name: '返回' }))
    expect(screen.getByRole('button', { name: '已记录词汇' })).toHaveFocus()

    fireEvent.click(screen.getByRole('button', { name: '设置' }))
    fireEvent.click(screen.getByRole('button', { name: '返回' }))
    expect(screen.getByRole('button', { name: '设置' })).toHaveFocus()
  })
})

describe('App practice page navigation', () => {
  const loadedWithHistory = (sessionId: string): LoadConversationResult => ({
    status: 'ok',
    conversation: summary(sessionId, NOW),
    messages: [
      {
        messageId: '3f70a8ae-7ad9-4eab-aaf4-1cae54a99708',
        sessionId,
        role: 'user',
        content: 'Hello',
        createdAt: NOW
      }
    ]
  })

  it('opens the practice page, hides the conversation view and restores focus on exit', async () => {
    const mock = installApiMock({
      list: { status: 'ok', conversations: [summary(SESSION_A, NOW)] },
      load: () => loadedWithHistory(SESSION_A)
    })
    await renderReady(mock)
    expect(await screen.findByText('Hello')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '开始练习' }))

    // 练习页替换对话视图；对话视图保持挂载但隐藏
    expect(screen.getByRole('main', { name: '开始练习' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '返回' })).toHaveFocus()
    expect(document.querySelector('.chat-shell')).toHaveAttribute('hidden')
    expect(screen.getByLabelText('练习内容')).not.toBeVisible()

    fireEvent.click(screen.getByRole('button', { name: '返回' }))

    expect(screen.queryByRole('main', { name: '开始练习' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '开始练习' })).toHaveFocus()
    expect(screen.getByLabelText('练习内容')).toBeVisible()
  })

  it('exits the practice page with Escape', async () => {
    const mock = installApiMock({
      list: { status: 'ok', conversations: [summary(SESSION_A, NOW)] },
      load: () => loadedWithHistory(SESSION_A)
    })
    await renderReady(mock)

    fireEvent.click(screen.getByRole('button', { name: '开始练习' }))
    fireEvent.keyDown(screen.getByRole('main', { name: '开始练习' }), { key: 'Escape' })

    expect(screen.queryByRole('main', { name: '开始练习' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '开始练习' })).toHaveFocus()
  })

  it('keeps the conversation, history and unsent draft across a practice page round trip', async () => {
    const mock = installApiMock({
      list: { status: 'ok', conversations: [summary(SESSION_A, NOW)] },
      load: () => loadedWithHistory(SESSION_A)
    })
    await renderReady(mock)
    fireEvent.change(screen.getByLabelText('练习内容'), { target: { value: 'unsent draft' } })

    fireEvent.click(screen.getByRole('button', { name: '开始练习' }))
    fireEvent.click(screen.getByRole('button', { name: '返回' }))

    expect(await screen.findByText('Hello')).toBeInTheDocument()
    expect(screen.getByLabelText('练习内容')).toHaveValue('unsent draft')
    expect(sessionButton(SESSION_A)).toHaveAttribute('aria-pressed', 'true')
    // 骨架阶段不发起任何数据请求，也不重复读取会话
    expect(mock.calls.list).toBe(1)
    expect(mock.calls.load).toEqual([SESSION_A])
  })

  it('does not reload data when the entry is clicked repeatedly', async () => {
    const mock = installApiMock({
      list: { status: 'ok', conversations: [summary(SESSION_A, NOW)] },
      load: () => loadedWithHistory(SESSION_A)
    })
    await renderReady(mock)

    fireEvent.click(screen.getByRole('button', { name: '开始练习' }))
    // 练习页打开期间侧栏入口处于隐藏视图内，需要显式包含隐藏元素
    fireEvent.click(screen.getByRole('button', { name: '开始练习', hidden: true }))

    expect(screen.getByRole('main', { name: '开始练习' })).toBeInTheDocument()
    expect(mock.calls.list).toBe(1)
    expect(mock.calls.load).toEqual([SESSION_A])
  })
})
