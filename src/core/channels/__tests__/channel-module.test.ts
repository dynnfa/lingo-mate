import { randomUUID } from 'node:crypto'
import { describe, expect, it, vi, type Mock } from 'vitest'
import { ConversationModule } from '../../conversation/conversation-module'
import type {
  ConversationRepository,
  StoredConversation,
  StoredMessage
} from '../../conversation/conversation-repository'
import type {
  ConversationSkillRepository,
  StoredConversationSkillExecution
} from '../../conversation/conversation-skill-repository'
import type { LanguageModel, ModelStreamEvent, StreamReplyInput } from '../../llm/language-model'
import type { SupportedLocale, TargetLanguage } from '../../../shared/preferences'
import type { VocabularyEntry } from '../../../shared/vocabulary'
import { normalizeLookupKey } from '../../learning/vocabulary/parse-vocabulary-input'
import type { VocabularyInsertCommand } from '../../learning/vocabulary/vocabulary-insert'
import type { VocabularyRepository } from '../../learning/vocabulary/vocabulary-repository'
import { VocabularyConversationSkill } from '../../learning/vocabulary/vocabulary-conversation-skill'
import { ChannelModule } from '../channel-module'
import { memoryChannelStore } from './fixtures'
import type {
  ChatChannelReplies,
  ChannelDeliveryOutcome,
  ChannelIntentResult,
  ChannelOutboundTarget,
  ChannelTransport,
  InboundChannelMessage
} from '../channel-types'
import type { ChannelPolicies } from '../channel-policies'

// ---- 测试替身：内存渠道存储 ----

// ---- 测试替身：内存会话仓储（同时实现技能执行仓储） ----

class MemoryConversationRepository implements ConversationRepository, ConversationSkillRepository {
  readonly conversations: StoredConversation[] = []
  readonly messages: StoredMessage[] = []
  readonly executions: StoredConversationSkillExecution[] = []

  async create(conversation: StoredConversation): Promise<void> {
    this.conversations.push(conversation)
  }

  async updateTitle(sessionId: string, title: string): Promise<void> {
    const conversation = this.conversations.find((item) => item.id === sessionId)
    if (conversation) conversation.title = title
  }

  async list(): Promise<StoredConversation[]> {
    return [...this.conversations]
  }

  async find(sessionId: string): Promise<StoredConversation | undefined> {
    return this.conversations.find((item) => item.id === sessionId)
  }

  async history(sessionId: string): Promise<StoredMessage[]> {
    return this.messages.filter((item) => item.sessionId === sessionId)
  }

  async appendMessage(message: StoredMessage, conversation?: StoredConversation): Promise<void> {
    if (conversation && !this.conversations.some((item) => item.id === conversation.id)) {
      this.conversations.push(conversation)
    }
    this.messages.push(message)
  }

  async createExecution(
    execution: StoredConversationSkillExecution,
    userMessage: StoredMessage,
    conversation?: StoredConversation
  ): Promise<void> {
    await this.appendMessage(userMessage, conversation)
    this.executions.push(structuredClone(execution))
  }

  async findExecutionByUserMessage(
    sessionId: string,
    userMessageId: string
  ): Promise<StoredConversationSkillExecution | undefined> {
    const execution = this.executions.find(
      (item) => item.sessionId === sessionId && item.userMessageId === userMessageId
    )
    return execution ? structuredClone(execution) : undefined
  }

  async setExecutionPhase(
    executionId: string,
    phase: StoredConversationSkillExecution['phase']
  ): Promise<void> {
    const execution = this.executions.find((item) => item.id === executionId)
    if (execution) execution.phase = phase
  }

  async finishExecution(
    executionId: string,
    phase: 'completed' | 'description_failed' | 'description_cancelled',
    assistantMessage: StoredMessage
  ): Promise<void> {
    const execution = this.executions.find((item) => item.id === executionId)
    if (execution) {
      execution.phase = phase
      execution.assistantMessageId = assistantMessage.id
    }
    this.messages.push(assistantMessage)
  }
}

// ---- 测试替身：模型、意图、平台、文案 ----

class SuccessfulModel implements LanguageModel {
  readonly inputs: StreamReplyInput[] = []
  async *streamReply(input: StreamReplyInput): AsyncIterable<ModelStreamEvent> {
    this.inputs.push(input)
    yield { type: 'text', delta: `assistant:${input.messages.at(-1)?.content ?? ''}` }
  }
}

// 阻塞模型：产出首个分片后挂起，直到请求被取消，用于测试 /cancel。
class BlockingModel implements LanguageModel {
  readonly inputs: StreamReplyInput[] = []
  async *streamReply(input: StreamReplyInput): AsyncIterable<ModelStreamEvent> {
    this.inputs.push(input)
    yield { type: 'text', delta: 'partial' }
    await new Promise<void>((resolve) => {
      if (input.signal.aborted) {
        resolve()
        return
      }
      input.signal.addEventListener('abort', () => resolve(), { once: true })
    })
  }
}

class RecordingTransport implements ChannelTransport {
  readonly sent: Array<{ target: ChannelOutboundTarget; text: string }> = []
  outcome: ChannelDeliveryOutcome = { delivered: true }

  async send(target: ChannelOutboundTarget, text: string): Promise<ChannelDeliveryOutcome> {
    this.sent.push({ target, text })
    return this.outcome
  }
}

function fakeReplies(): ChatChannelReplies {
  const tag = (name: string) => (language: SupportedLocale) => `${name}[${language}]`
  return {
    help: tag('help'),
    notBound: tag('notBound'),
    alreadyBound: tag('alreadyBound'),
    bindingRequested: tag('bindingRequested'),
    bindingCodeMismatch: tag('bindingCodeMismatch'),
    bindingCodeExpired: tag('bindingCodeExpired'),
    bindingCodeExhausted: tag('bindingCodeExhausted'),
    noActiveBindingCode: tag('noActiveBindingCode'),
    confirmationPrompt: (language, detail) =>
      `confirmationPrompt[${language}]:${detail.words.join(',')}@${detail.targetLanguage}`,
    confirmNoPending: tag('confirmNoPending'),
    confirmLanguageChanged: (language, detail) =>
      `confirmLanguageChanged[${language}]:${detail.words.join(',')}@${detail.targetLanguage}`,
    confirmExpired: tag('confirmExpired'),
    intentClarify: tag('intentClarify'),
    cancelReport: (language, detail) => `cancelReport[${language}]:${detail.cancelled}`,
    cancelIdle: tag('cancelIdle'),
    newSessionBusy: tag('newSessionBusy'),
    newSessionStarted: tag('newSessionStarted'),
    queueBusy: tag('queueBusy'),
    rateLimited: tag('rateLimited'),
    messageTooLong: tag('messageTooLong'),
    executionFailed: tag('executionFailed'),
    needsAttention: tag('needsAttention')
  }
}

function memoryVocabularyRepository(
  onBatchCommitted?: (executionId: string, batch: unknown) => void
): VocabularyRepository & { commands: VocabularyInsertCommand[] } {
  const commands: VocabularyInsertCommand[] = []
  const toEntry = (command: VocabularyInsertCommand): VocabularyEntry => ({
    id: command.parameters.id,
    term: command.parameters.term,
    phonetic: JSON.parse(command.parameters.phonetic) as string[],
    meaning: command.parameters.meaning,
    concept: command.parameters.concept,
    exampleSentences: JSON.parse(command.parameters.example_sentences) as string[],
    createdAt: command.parameters.created_at
  })
  const save = (
    values: VocabularyInsertCommand[]
  ): Array<{ id: string; status: 'saved' | 'existing' }> =>
    values.map((value) => {
      const key = normalizeLookupKey(value.parameters.term)
      const existing = commands.find((item) => normalizeLookupKey(item.parameters.term) === key)
      if (existing) return { id: existing.parameters.id, status: 'existing' as const }
      commands.push(value)
      return { id: value.parameters.id, status: 'saved' as const }
    })
  return {
    commands,
    find: (lookupKey) => {
      const command = commands.find(
        (item) => normalizeLookupKey(item.parameters.term) === lookupKey
      )
      return command ? toEntry(command) : undefined
    },
    findExisting: (lookupKeys) => {
      const found = new Map<string, VocabularyEntry>()
      for (const key of lookupKeys) {
        const command = commands.find((item) => normalizeLookupKey(item.parameters.term) === key)
        if (command) found.set(key, toEntry(command))
      }
      return found
    },
    saveBatch: save,
    saveBatchWithResult: (executionId, values, finalize) => {
      const batch = finalize(save(values))
      onBatchCommitted?.(executionId, batch)
      return batch
    },
    list: () => ({ entries: commands.map(toEntry) }),
    sampleRandom: (count) => commands.map(toEntry).slice(0, count),
    deleteById: (id) => {
      const index = commands.findIndex((command) => command.parameters.id === id)
      if (index === -1) return false
      commands.splice(index, 1)
      return true
    }
  }
}

// ---- 装配 ----

const CONNECTION_ID = randomUUID()

// 模块级事件序号：跨 harness（含重启场景）递增，保证 eventId 唯一。
let eventSeq = 1000
function nextEventId(): number {
  eventSeq += 1
  return eventSeq
}

function makeInbound(overrides: Partial<InboundChannelMessage> = {}): InboundChannelMessage {
  const eventId = nextEventId()
  return {
    platform: 'telegram',
    connectionId: CONNECTION_ID,
    botId: '6000000001',
    eventId,
    messageId: eventId,
    senderId: '7000000001',
    chatId: '8000000001',
    sentAt: '2026-09-23T11:59:00.000Z',
    receivedAt: '2026-09-23T12:00:00.000Z',
    text: 'hello',
    senderName: 'Leon',
    ...overrides
  }
}

// 重启：保留同一持久化替身与模型，重建运行期状态（模块与会话草稿丢失）。
function buildHarnessFrom(
  previous: ReturnType<typeof buildHarness>
): ReturnType<typeof buildHarness> {
  const vocabularySkill = new VocabularyConversationSkill(
    previous.vocabularyRepository,
    () => ({
      analyzer: {
        analyze: async ({ term }: { term: string }) => ({
          status: 'insert' as const,
          content: {
            term,
            phonetic: ['/ˈtekst/'],
            meaning: '测试释义',
            concept: '测试概念',
            exampleSentences: ['Test sentence.']
          },
          modelId: 'fixture-model',
          promptVersion: 'vocabulary-tools-v4'
        })
      }
    }),
    (batch: { counts: { saved: number; existing: number } }) =>
      `vocab-feedback:saved=${batch.counts.saved},existing=${batch.counts.existing}`
  )
  const conversations = new ConversationModule(
    previous.model,
    previous.conversationRepository,
    () => previous.languages,
    new Map([[vocabularySkill.skillId, vocabularySkill]]),
    previous.conversationRepository
  )
  const module = new ChannelModule({
    store: previous.store,
    conversations,
    conversationStore: previous.conversationRepository,
    skills: new Map([[vocabularySkill.skillId, vocabularySkill]]),
    intentRecognizer: { recognize: previous.recognize },
    replies: fakeReplies(),
    transport: previous.transport,
    resolveLanguages: () => previous.languages,
    now: () => new Date('2026-09-23T12:00:00.000Z')
  })
  return {
    store: previous.store,
    conversationRepository: previous.conversationRepository,
    model: previous.model,
    vocabularyRepository: previous.vocabularyRepository,
    conversations,
    transport: previous.transport,
    recognize: previous.recognize,
    module,
    inbound: makeInbound,
    languages: previous.languages
  }
}

interface RecordingModel extends LanguageModel {
  readonly inputs: StreamReplyInput[]
}

export interface ChannelIntentInputShape {
  text: string
  outputLanguage: SupportedLocale
  targetLanguage: TargetLanguage
  signal: AbortSignal
}

interface Harness {
  store: ReturnType<typeof memoryChannelStore>
  conversationRepository: MemoryConversationRepository
  model: RecordingModel
  vocabularyRepository: ReturnType<typeof memoryVocabularyRepository>
  conversations: ConversationModule
  transport: RecordingTransport
  recognize: Mock<(input: ChannelIntentInputShape) => Promise<ChannelIntentResult>>
  module: ChannelModule
  inbound: (overrides?: Partial<InboundChannelMessage>) => InboundChannelMessage
  languages: { outputLanguage: SupportedLocale; targetLanguage: TargetLanguage }
}

export function buildHarness(
  options: {
    outputLanguage?: SupportedLocale
    targetLanguage?: TargetLanguage
    model?: RecordingModel
    policies?: Partial<ChannelPolicies>
    recognize?: (input: ChannelIntentInputShape) => Promise<ChannelIntentResult>
  } = {}
): Harness {
  const store = memoryChannelStore()
  store.saveConnection({
    connectionId: CONNECTION_ID,
    platform: 'telegram',
    botId: '6000000001',
    botUsername: 'lingo_mate_bot',
    createdAt: '2026-09-23T08:00:00.000Z',
    updatedAt: '2026-09-23T08:00:00.000Z'
  })
  const conversationRepository = new MemoryConversationRepository()
  const model = options.model ?? new SuccessfulModel()
  // 模拟生产耦合：词库提交与技能执行批次在同一持久化事实中落盘。
  const vocabularyRepository = memoryVocabularyRepository((executionId, batch) => {
    const execution = conversationRepository.executions.find((item) => item.id === executionId)
    if (execution) execution.batch = batch as never
  })
  const languages = {
    outputLanguage: options.outputLanguage ?? ('zh-CN' as SupportedLocale),
    targetLanguage: options.targetLanguage ?? ('en' as TargetLanguage)
  }
  const vocabularySkill = new VocabularyConversationSkill(
    vocabularyRepository,
    () => ({
      analyzer: {
        analyze: vi.fn(async ({ term }: { term: string }) => ({
          status: 'insert' as const,
          content: {
            term,
            phonetic: ['/ˈtekst/'],
            meaning: '测试释义',
            concept: '测试概念',
            exampleSentences: ['Test sentence.']
          },
          modelId: 'fixture-model',
          promptVersion: 'vocabulary-tools-v4'
        }))
      }
    }),
    (batch) => `vocab-feedback:saved=${batch.counts.saved},existing=${batch.counts.existing}`
  )
  const conversations = new ConversationModule(
    model,
    conversationRepository,
    () => languages,
    new Map([[vocabularySkill.skillId, vocabularySkill]]),
    conversationRepository
  )
  const transport = new RecordingTransport()
  const recognize = vi.fn(
    options.recognize ??
      (async (input: ChannelIntentInputShape): Promise<ChannelIntentResult> => {
        void input
        return { status: 'none' }
      })
  )
  const module = new ChannelModule({
    store,
    conversations,
    conversationStore: conversationRepository,
    skills: new Map([[vocabularySkill.skillId, vocabularySkill]]),
    intentRecognizer: { recognize },
    replies: fakeReplies(),
    transport,
    resolveLanguages: () => languages,
    policies: options.policies,
    now: () => new Date('2026-09-23T12:00:00.000Z')
  })
  const inbound = makeInbound
  return {
    store,
    conversationRepository,
    model,
    vocabularyRepository,
    conversations,
    transport,
    recognize,
    module,
    inbound,
    languages
  }
}

export async function bindAccount(harness: ReturnType<typeof buildHarness>): Promise<void> {
  const { code } = await harness.module.issueBindingCode()
  await harness.module.handleInbound(
    harness.inbound({ text: `/start ${code}`, senderName: 'Leon' })
  )
  await harness.module.confirmPendingBinding()
  await vi.waitFor(() => {
    expect(harness.transport.sent.some(({ text }) => text.startsWith('bindingRequested['))).toBe(
      true
    )
  })
}

describe('ChannelModule inbound authorization', () => {
  it('rejects messages from unbound senders with a bind hint and no body retained', async () => {
    const harness = buildHarness()
    await harness.module.handleInbound(harness.inbound({ text: 'hello' }))

    expect(harness.transport.sent).toHaveLength(1)
    expect(harness.transport.sent[0]).toMatchObject({
      target: { platform: 'telegram', chatId: '8000000001' },
      text: 'notBound[zh-CN]'
    })
    const record = harness.store.inbound[0]
    expect(record.status).toBe('ignored')
    expect(record.text).toBeNull()
    expect(harness.model.inputs).toHaveLength(0)
  })
})

// 只统计对话主回复调用：标题生成（conversation-title）不计入。
function conversationCalls(model: { inputs: StreamReplyInput[] }): StreamReplyInput[] {
  return model.inputs.filter((input) => input.promptKind !== 'conversation-title')
}

async function waitForReply(
  harness: ReturnType<typeof buildHarness>,
  predicate: (text: string) => boolean
): Promise<void> {
  await vi.waitFor(() => {
    expect(harness.transport.sent.some(({ text }) => predicate(text))).toBe(true)
  })
}

describe('ChannelModule command dispatch and execution', () => {
  it('answers /help immediately without touching the model or vocabulary', async () => {
    const harness = buildHarness()
    await bindAccount(harness)
    harness.transport.sent.length = 0

    await harness.module.handleInbound(harness.inbound({ text: '/help' }))
    await waitForReply(harness, (text) => text === 'help[zh-CN]')
    expect(harness.model.inputs).toHaveLength(0)
    expect(harness.store.inbound.at(-1)?.status).toBe('succeeded')
  })

  it('runs the vocabulary skill for /save and replies with the persisted feedback', async () => {
    const harness = buildHarness()
    await bindAccount(harness)
    harness.transport.sent.length = 0

    await harness.module.handleInbound(harness.inbound({ text: '/save apple' }))
    await waitForReply(harness, (text) => text === 'vocab-feedback:saved=1,existing=0')

    expect(harness.vocabularyRepository.commands.map((c) => c.parameters.term)).toEqual(['apple'])
    const record = harness.store.inbound.find((item) => item.text === '/save apple')
    expect(record?.status).toBe('succeeded')
    expect(record?.executionRef).not.toBeNull()
    const reply = harness.store.replies.at(-1)
    expect(reply).toMatchObject({
      status: 'sent',
      chatId: '8000000001',
      inboundId: record?.inboundId
    })
    expect(reply?.text).toBe('vocab-feedback:saved=1,existing=0')
  })

  it('saves multiple words and reports existing words by domain rules', async () => {
    const harness = buildHarness()
    await bindAccount(harness)
    harness.transport.sent.length = 0

    await harness.module.handleInbound(harness.inbound({ text: '/save apple' }))
    await waitForReply(harness, (text) => text === 'vocab-feedback:saved=1,existing=0')
    await harness.module.handleInbound(harness.inbound({ text: '/save apple, banana' }))
    await waitForReply(harness, (text) => text === 'vocab-feedback:saved=1,existing=1')

    expect(harness.vocabularyRepository.commands.map((c) => c.parameters.term).sort()).toEqual([
      'apple',
      'banana'
    ])
  })

  it('answers plain questions through the conversation model with session context', async () => {
    const harness = buildHarness()
    await bindAccount(harness)
    harness.transport.sent.length = 0

    await harness.module.handleInbound(harness.inbound({ text: 'what is an apple?' }))
    await waitForReply(harness, (text) => text === 'assistant:what is an apple?')
    expect(harness.recognize).toHaveBeenCalledTimes(1)
    expect(harness.recognize.mock.calls[0][0]).toMatchObject({
      outputLanguage: 'zh-CN',
      targetLanguage: 'en'
    })

    await harness.module.handleInbound(harness.inbound({ text: 'and banana?' }))
    await waitForReply(harness, (text) => text === 'assistant:and banana?')
    const secondCall = harness.model.inputs.at(-1)
    expect(secondCall?.messages.map((m) => m.content)).toEqual([
      'what is an apple?',
      'assistant:what is an apple?',
      'and banana?'
    ])
  })

  it('replies with help for unknown commands instead of executing them', async () => {
    const harness = buildHarness()
    await bindAccount(harness)
    harness.transport.sent.length = 0

    await harness.module.handleInbound(harness.inbound({ text: '/delete everything' }))
    await waitForReply(harness, (text) => text === 'help[zh-CN]')
    expect(harness.model.inputs).toHaveLength(0)
    expect(harness.store.inbound.at(-1)?.status).toBe('ignored')
  })

  it('treats non-command slash text that fails command grammar as a plain message', async () => {
    const harness = buildHarness()
    await bindAccount(harness)
    harness.transport.sent.length = 0

    await harness.module.handleInbound(harness.inbound({ text: '/drop-table users' }))
    await waitForReply(harness, (text) => text === 'assistant:/drop-table users')
    expect(harness.store.inbound.at(-1)?.kind).toBe('message')
  })

  it('rejects oversized input with clear feedback', async () => {
    const harness = buildHarness()
    await bindAccount(harness)
    harness.transport.sent.length = 0

    await harness.module.handleInbound(harness.inbound({ text: 'x'.repeat(4001) }))
    await waitForReply(harness, (text) => text === 'messageTooLong[zh-CN]')
    expect(harness.model.inputs).toHaveLength(0)
    expect(harness.store.inbound.at(-1)?.status).toBe('ignored')
  })
})

describe('ChannelModule binding flow', () => {
  it('issues a one-time code and creates a pending binding after /start', async () => {
    const harness = buildHarness()
    const { code } = await harness.module.issueBindingCode()
    expect(code).toMatch(/^[A-Z2-9]{6}$/)

    await harness.module.handleInbound(harness.inbound({ text: `/start ${code}` }))
    await vi.waitFor(() => {
      expect(harness.transport.sent.some(({ text }) => text.startsWith('bindingRequested['))).toBe(
        true
      )
    })
    const pending = harness.store.findPendingBinding(CONNECTION_ID)
    expect(pending).toMatchObject({
      senderId: '7000000001',
      chatId: '8000000001',
      displayName: 'Leon',
      status: 'pending'
    })
    expect(harness.store.bindingCodes[0].consumedAt).not.toBeNull()
  })

  it('activates the binding only after desktop confirmation', async () => {
    const harness = buildHarness()
    const { code } = await harness.module.issueBindingCode()
    await harness.module.handleInbound(harness.inbound({ text: `/start ${code}` }))

    const binding = await harness.module.confirmPendingBinding()
    expect(binding.status).toBe('active')
    expect(harness.store.findActiveBinding(CONNECTION_ID)?.bindingId).toBe(binding.bindingId)
  })

  it('rejects mismatching codes and counts attempts toward invalidation', async () => {
    const harness = buildHarness()
    await harness.module.issueBindingCode()

    await harness.module.handleInbound(harness.inbound({ text: '/start WRONG1' }))
    await vi.waitFor(() => {
      expect(harness.transport.sent.some(({ text }) => text === 'bindingCodeMismatch[zh-CN]')).toBe(
        true
      )
    })
    expect(harness.store.bindingCodes[0].attempts).toBe(1)

    // 同一码被正确发送后仍可绑定：尝试次数未超限。
    const { code } = { code: harness.store.bindingCodes[0].code }
    await harness.module.handleInbound(harness.inbound({ text: `/start ${code}` }))
    expect(harness.store.findPendingBinding(CONNECTION_ID)).toBeDefined()
  })

  it('replies alreadyBound when a bound sender sends /start again', async () => {
    const harness = buildHarness()
    await bindAccount(harness)

    await harness.module.handleInbound(harness.inbound({ text: '/start ABC234' }))
    await vi.waitFor(() => {
      expect(harness.transport.sent.some(({ text }) => text === 'alreadyBound[zh-CN]')).toBe(true)
    })
  })

  it('issues fresh codes that replace unconsumed ones', async () => {
    const harness = buildHarness()
    const first = await harness.module.issueBindingCode()
    const second = await harness.module.issueBindingCode()
    expect(first.code).not.toBe(second.code)

    // 被替换的旧码视为不匹配，提示用户使用最新码。
    await harness.module.handleInbound(harness.inbound({ text: `/start ${first.code}` }))
    await vi.waitFor(() => {
      expect(harness.transport.sent.some(({ text }) => text === 'bindingCodeMismatch[zh-CN]')).toBe(
        true
      )
    })
    expect(harness.store.bindingCodes[0].code).toBe(second.code)
  })
})

describe('ChannelModule natural language save confirmation', () => {
  it('does not let an old confirmation authorize a newer word', async () => {
    const harness = buildHarness({
      recognize: async ({ text }) => ({ status: 'save', words: [text] })
    })
    await bindAccount(harness)
    await harness.module.handleInbound(harness.inbound({ text: 'apple' }))
    await waitForReply(harness, (text) => text.startsWith('confirmationPrompt['))
    const oldOperationId = harness.store.confirmations.at(-1)!.operationId
    await harness.module.handleInbound(harness.inbound({ text: 'banana' }))
    await vi.waitFor(() => expect(harness.store.confirmations.at(-1)?.words).toEqual(['banana']))
    await harness.module.handleInbound(harness.inbound({ text: `/confirm ${oldOperationId}` }))
    await waitForReply(harness, (text) => text === 'confirmNoPending[zh-CN]')
    expect(harness.vocabularyRepository.commands).toHaveLength(0)
  })

  it('does not start a model request after unbinding during intent recognition', async () => {
    let finishRecognition!: (result: ChannelIntentResult) => void
    const harness = buildHarness({
      recognize: () =>
        new Promise((resolve) => {
          finishRecognition = resolve
        })
    })
    await bindAccount(harness)
    await harness.module.handleInbound(harness.inbound({ text: 'question' }))
    await vi.waitFor(() => expect(harness.recognize).toHaveBeenCalledOnce())
    await harness.module.unbind()
    finishRecognition({ status: 'none' })
    await vi.waitFor(() => expect(harness.store.inbound.at(-1)?.status).toBe('cancelled'))
    await new Promise((resolve) => setImmediate(resolve))
    expect(harness.model.inputs).toHaveLength(0)
  })

  it('cancels intent recognition before it can launch a conversation', async () => {
    let finishRecognition!: (result: ChannelIntentResult) => void
    const harness = buildHarness({
      recognize: () =>
        new Promise((resolve) => {
          finishRecognition = resolve
        })
    })
    await bindAccount(harness)
    await harness.module.handleInbound(harness.inbound({ text: 'question' }))
    await vi.waitFor(() => expect(harness.recognize).toHaveBeenCalledOnce())
    await harness.module.handleInbound(harness.inbound({ text: '/cancel' }))
    finishRecognition({ status: 'none' })
    await new Promise((resolve) => setImmediate(resolve))
    expect(harness.model.inputs).toHaveLength(0)
    expect(harness.store.inbound.find((item) => item.text === 'question')?.status).toBe('cancelled')
  })

  it('asks for confirmation before saving words recognized from natural language', async () => {
    const harness = buildHarness({
      recognize: async () => ({ status: 'save', words: ['apple', 'banana'] })
    })
    await bindAccount(harness)
    harness.transport.sent.length = 0

    await harness.module.handleInbound(harness.inbound({ text: '帮我记住 apple 和 banana' }))
    await waitForReply(harness, (text) => text === 'confirmationPrompt[zh-CN]:apple,banana@en')

    expect(harness.vocabularyRepository.commands).toHaveLength(0)
    expect(harness.model.inputs).toHaveLength(0)
    const record = harness.store.inbound.at(-1)
    expect(record?.status).toBe('pending_confirmation')
    expect(harness.store.confirmations.at(-1)).toMatchObject({
      words: ['apple', 'banana'],
      targetLanguage: 'en',
      explanationLanguage: 'zh-CN',
      consumedAt: null
    })
  })

  it('executes the save after /confirm and consumes the one-time confirmation', async () => {
    const harness = buildHarness({
      recognize: async () => ({ status: 'save', words: ['apple'] })
    })
    await bindAccount(harness)
    await harness.module.handleInbound(harness.inbound({ text: '帮我记住 apple' }))
    await waitForReply(harness, (text) => text.startsWith('confirmationPrompt['))

    const operationId = harness.store.confirmations.at(-1)!.operationId
    await harness.module.handleInbound(harness.inbound({ text: `/confirm ${operationId}` }))
    await waitForReply(harness, (text) => text === 'vocab-feedback:saved=1,existing=0')
    expect(harness.vocabularyRepository.commands.map((c) => c.parameters.term)).toEqual(['apple'])
    expect(harness.store.confirmations[0].consumedAt).not.toBeNull()

    // 一次性确认：重放 /confirm 不得再次写入。
    await harness.module.handleInbound(harness.inbound({ text: `/confirm ${operationId}` }))
    await waitForReply(harness, (text) => text === 'confirmNoPending[zh-CN]')
    expect(harness.vocabularyRepository.commands).toHaveLength(1)
  })

  it('asks to re-confirm when the target language changed since the prompt', async () => {
    const harness = buildHarness({
      recognize: async () => ({ status: 'save', words: ['apple'] })
    })
    await bindAccount(harness)
    await harness.module.handleInbound(harness.inbound({ text: '帮我记住 apple' }))
    await waitForReply(harness, (text) => text.startsWith('confirmationPrompt['))

    // 模拟未来支持多目标语言后的语言变更。
    harness.languages.targetLanguage = 'fr' as unknown as typeof harness.languages.targetLanguage
    const operationId = harness.store.confirmations.at(-1)!.operationId
    await harness.module.handleInbound(harness.inbound({ text: `/confirm ${operationId}` }))
    await waitForReply(harness, (text) => text === 'confirmLanguageChanged[zh-CN]:apple@fr')
    // 语言变化时不得直接写入：旧确认作废，替换为新语言快照的待确认记录。
    expect(harness.vocabularyRepository.commands).toHaveLength(0)
    expect(harness.store.confirmations.at(-1)).toMatchObject({
      targetLanguage: 'fr',
      consumedAt: null
    })
  })

  it('replies clarify guidance when the save intent is ambiguous', async () => {
    const harness = buildHarness({
      recognize: async () => ({ status: 'clarify' })
    })
    await bindAccount(harness)
    harness.transport.sent.length = 0

    await harness.module.handleInbound(harness.inbound({ text: 'apple?' }))
    await waitForReply(harness, (text) => text === 'intentClarify[zh-CN]')
    expect(harness.model.inputs).toHaveLength(0)
    expect(harness.vocabularyRepository.commands).toHaveLength(0)
  })

  it('invalidates the pending confirmation on /cancel and reports it', async () => {
    const harness = buildHarness({
      recognize: async () => ({ status: 'save', words: ['apple'] })
    })
    await bindAccount(harness)
    await harness.module.handleInbound(harness.inbound({ text: '帮我记住 apple' }))
    await waitForReply(harness, (text) => text.startsWith('confirmationPrompt['))
    harness.transport.sent.length = 0

    await harness.module.handleInbound(harness.inbound({ text: '/cancel' }))
    await waitForReply(harness, (text) => text === 'cancelReport[zh-CN]:0')
    expect(harness.store.confirmations[0].consumedAt).not.toBeNull()

    await harness.module.handleInbound(harness.inbound({ text: '/confirm' }))
    await waitForReply(harness, (text) => text === 'confirmNoPending[zh-CN]')
    expect(harness.vocabularyRepository.commands).toHaveLength(0)
  })
})

describe('ChannelModule session control', () => {
  it('cancels a running request immediately via /cancel and clears the queue', async () => {
    const harness = buildHarness({ model: new BlockingModel() })
    await bindAccount(harness)
    harness.transport.sent.length = 0

    await harness.module.handleInbound(harness.inbound({ text: 'first question' }))
    await vi.waitFor(() => expect(conversationCalls(harness.model)).toHaveLength(1))
    const first = harness.store.inbound.find((item) => item.text === 'first question')
    expect(first?.executionRef?.userMessageId).toBe(
      harness.conversationRepository.messages.find((item) => item.content === 'first question')?.id
    )
    await harness.module.handleInbound(harness.inbound({ text: 'second question' }))
    await harness.module.handleInbound(harness.inbound({ text: '/cancel' }))
    await waitForReply(harness, (text) => text === 'cancelReport[zh-CN]:2')

    // 队列清空：被排队的第二条消息标记取消，不再执行。
    await vi.waitFor(() => {
      const second = harness.store.inbound.find((item) => item.text === 'second question')
      expect(second?.status).toBe('cancelled')
    })
    expect(conversationCalls(harness.model)).toHaveLength(1)
  })

  it('replies cancelIdle when nothing is running, queued or pending confirmation', async () => {
    const harness = buildHarness()
    await bindAccount(harness)
    harness.transport.sent.length = 0

    await harness.module.handleInbound(harness.inbound({ text: '/cancel' }))
    await waitForReply(harness, (text) => text === 'cancelIdle[zh-CN]')
  })

  it('rejects /new while tasks are running and starts a fresh session when idle', async () => {
    const harness = buildHarness({ model: new BlockingModel() })
    await bindAccount(harness)
    harness.transport.sent.length = 0

    await harness.module.handleInbound(harness.inbound({ text: 'a question' }))
    await vi.waitFor(() => expect(conversationCalls(harness.model)).toHaveLength(1))
    await harness.module.handleInbound(harness.inbound({ text: '/new' }))
    await waitForReply(harness, (text) => text === 'newSessionBusy[zh-CN]')

    await harness.module.handleInbound(harness.inbound({ text: '/cancel' }))
    await waitForReply(harness, (text) => text === 'cancelReport[zh-CN]:1')
    harness.transport.sent.length = 0
    await harness.module.handleInbound(harness.inbound({ text: '/new' }))
    await waitForReply(harness, (text) => text === 'newSessionStarted[zh-CN]')

    // 新上下文：旧历史不再进入模型输入。
    const model = harness.model as BlockingModel
    model.inputs.length = 0
    await harness.module.handleInbound(harness.inbound({ text: 'fresh start' }))
    await vi.waitFor(() => expect(conversationCalls(model)).toHaveLength(1))
    expect(conversationCalls(model)[0].messages.map((m) => m.content)).toEqual(['fresh start'])
  })
})

describe('ChannelModule reliability', () => {
  it('ignores redelivered updates by idempotency key without re-executing', async () => {
    const harness = buildHarness()
    await bindAccount(harness)
    harness.transport.sent.length = 0

    const message = harness.inbound({ text: 'hello there', eventId: 4242, messageId: 4242 })
    await harness.module.handleInbound(message)
    await waitForReply(harness, (text) => text === 'assistant:hello there')
    harness.transport.sent.length = 0

    await harness.module.handleInbound(message)
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(harness.transport.sent).toHaveLength(0)
    expect(conversationCalls(harness.model)).toHaveLength(1)
    expect(harness.store.inbound.filter((item) => item.eventId === 4242)).toHaveLength(1)
  })

  it('expires backlog messages older than the TTL without executing them', async () => {
    const harness = buildHarness()
    await bindAccount(harness)
    harness.transport.sent.length = 0

    await harness.module.handleInbound(
      harness.inbound({
        text: '/save apple',
        sentAt: '2026-09-23T10:00:00.000Z',
        receivedAt: '2026-09-23T12:00:00.000Z'
      })
    )
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(conversationCalls(harness.model)).toHaveLength(0)
    expect(harness.vocabularyRepository.commands).toHaveLength(0)
    expect(harness.transport.sent).toHaveLength(0)
    expect(harness.store.inbound.at(-1)?.status).toBe('expired')
  })

  it('rejects work beyond the session queue limit with queueBusy feedback', async () => {
    const harness = buildHarness({
      model: new BlockingModel(),
      policies: { sessionQueueLimit: 2 }
    })
    await bindAccount(harness)
    harness.transport.sent.length = 0

    for (let index = 0; index < 4; index += 1) {
      await harness.module.handleInbound(harness.inbound({ text: `message ${index}` }))
    }
    await waitForReply(harness, (text) => text === 'queueBusy[zh-CN]')
    const statuses = harness.store.inbound
      .filter((item) => (item.text ?? '').startsWith('message '))
      .map((item) => item.status)
    expect(statuses.filter((status) => status === 'failed')).toHaveLength(1)
  })

  it('keeps undelivered replies pending and redelivers them on demand', async () => {
    const harness = buildHarness()
    await bindAccount(harness)
    harness.transport.outcome = { delivered: false }

    await harness.module.handleInbound(harness.inbound({ text: 'hello' }))
    await vi.waitFor(() => {
      expect(harness.store.replies.at(-1)?.attempts).toBe(1)
    })
    expect(harness.store.replies.at(-1)?.status).toBe('pending')
    expect(conversationCalls(harness.model)).toHaveLength(1)

    harness.transport.outcome = { delivered: true }
    await harness.module.deliverPendingReplies()
    expect(harness.store.replies.at(-1)?.status).toBe('sent')
    expect(harness.transport.sent.at(-1)?.text).toBe('assistant:hello')
  })

  it('does not consume a delivery attempt while the connection is offline', async () => {
    const harness = buildHarness()
    await bindAccount(harness)
    harness.transport.outcome = { delivered: false, deferred: true }
    await harness.module.handleInbound(harness.inbound({ text: '/save apple' }))
    await vi.waitFor(() => expect(harness.store.replies.at(-1)?.status).toBe('pending'))
    expect(harness.store.replies.at(-1)?.attempts).toBe(0)
  })

  it('does not send a reply after its delivery lifetime has expired', async () => {
    const harness = buildHarness({ policies: { replyTtlMs: 1_000 } })
    await bindAccount(harness)
    harness.transport.sent.length = 0
    harness.store.saveReply({
      replyId: randomUUID(),
      connectionId: CONNECTION_ID,
      platform: 'telegram',
      chatId: '8000000001',
      senderId: '7000000001',
      sessionId: null,
      inboundId: null,
      text: 'stale result',
      status: 'pending',
      attempts: 0,
      createdAt: '2026-09-23T11:00:00.000Z',
      updatedAt: '2026-09-23T11:00:00.000Z',
      sentAt: null
    })
    await harness.module.deliverPendingReplies()
    expect(harness.store.replies.at(-1)?.status).toBe('failed')
    expect(harness.transport.sent).toHaveLength(0)
  })

  it('marks replies failed after exhausting the retry budget', async () => {
    const harness = buildHarness({ policies: { replyMaxAttempts: 1 } })
    await bindAccount(harness)
    harness.transport.outcome = { delivered: false }

    await harness.module.handleInbound(harness.inbound({ text: 'hello' }))
    await vi.waitFor(() => {
      expect(harness.store.replies.at(-1)?.status).toBe('failed')
    })
  })
})

describe('ChannelModule unbind and disconnect semantics', () => {
  it('unbind cancels running and queued work, drops undelivered replies and blocks access', async () => {
    const harness = buildHarness({ model: new BlockingModel() })
    await bindAccount(harness)
    await harness.module.handleInbound(harness.inbound({ text: 'running question' }))
    await vi.waitFor(() => expect(conversationCalls(harness.model)).toHaveLength(1))
    await harness.module.handleInbound(harness.inbound({ text: 'queued question' }))
    // 留下一条未投递的结果回复。
    const failingHarness = harness
    failingHarness.transport.outcome = { delivered: false }
    await harness.module.handleInbound(harness.inbound({ text: '/help' }))
    await new Promise((resolve) => setTimeout(resolve, 50))

    await harness.module.unbind()

    expect(harness.store.findActiveBinding(CONNECTION_ID)).toBeUndefined()
    expect(harness.store.inbound.find((item) => item.text === 'running question')?.status).toBe(
      'cancelled'
    )
    expect(harness.store.inbound.find((item) => item.text === 'queued question')?.status).toBe(
      'cancelled'
    )
    expect(harness.store.listPendingReplies(CONNECTION_ID)).toHaveLength(0)

    harness.transport.outcome = { delivered: true }
    await harness.module.handleInbound(harness.inbound({ text: 'hello again' }))
    await waitForReply(harness, (text) => text === 'notBound[zh-CN]')
    expect(conversationCalls(harness.model)).toHaveLength(1)
  })

  it('disconnect pauses delivery and cancels tasks; resume redelivers completed results', async () => {
    const harness = buildHarness()
    await bindAccount(harness)
    harness.transport.outcome = { delivered: false }
    await harness.module.handleInbound(harness.inbound({ text: 'a question' }))
    await vi.waitFor(() => expect(harness.store.replies.length).toBeGreaterThan(0))

    harness.module.pauseConnection()
    // 断开后不再投递。
    await harness.module.deliverPendingReplies()
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(harness.store.replies.at(-1)?.status).toBe('pending')

    harness.transport.outcome = { delivered: true }
    await harness.module.deliverPendingReplies()
    expect(harness.store.replies.at(-1)?.status).toBe('sent')
  })
})

describe('ChannelModule crash recovery', () => {
  function restart(harness: ReturnType<typeof buildHarness>): ReturnType<typeof buildHarness> {
    return buildHarnessFrom(harness)
  }

  it('re-dispatches received-but-unexecuted inbound after re-checking binding', async () => {
    const harness = buildHarness()
    await bindAccount(harness)
    // 模拟崩溃：落盘后、分派前中断。
    const record = {
      inboundId: randomUUID(),
      connectionId: CONNECTION_ID,
      platform: 'telegram' as const,
      botId: '6000000001',
      eventId: 9001,
      messageId: 9001,
      chatId: '8000000001',
      senderId: '7000000001',
      sentAt: '2026-09-23T11:59:00.000Z',
      receivedAt: '2026-09-23T12:00:00.000Z',
      text: 'recovered question',
      kind: 'message' as const,
      status: 'received' as const,
      sessionId: null,
      executionRef: null,
      createdAt: '2026-09-23T12:00:00.000Z',
      updatedAt: '2026-09-23T12:00:00.000Z'
    }
    harness.store.inbound.push(record)

    const restarted = restart(harness)
    await restarted.module.recover()
    await waitForReply(restarted, (text) => text === 'assistant:recovered question')
    expect(harness.store.inbound.find((item) => item.eventId === 9001)?.status).toBe('succeeded')
  })

  it('does not re-dispatch expired records during recovery', async () => {
    const harness = buildHarness()
    await bindAccount(harness)
    harness.store.inbound.push({
      inboundId: randomUUID(),
      connectionId: CONNECTION_ID,
      platform: 'telegram',
      botId: '6000000001',
      eventId: 9002,
      messageId: 9002,
      chatId: '8000000001',
      senderId: '7000000001',
      sentAt: '2026-09-23T10:00:00.000Z',
      receivedAt: '2026-09-23T12:00:00.000Z',
      text: '/save apple',
      kind: 'command',
      status: 'received',
      sessionId: null,
      executionRef: null,
      createdAt: '2026-09-23T12:00:00.000Z',
      updatedAt: '2026-09-23T12:00:00.000Z'
    })

    harness.transport.sent.length = 0
    const restarted = restart(harness)
    await restarted.module.recover()
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(harness.store.inbound.find((item) => item.eventId === 9002)?.status).toBe('expired')
    expect(harness.vocabularyRepository.commands).toHaveLength(0)
    expect(restarted.transport.sent.length).toBe(0)
  })

  it('rebuilds the reply from committed results when the channel reply was never persisted', async () => {
    const harness = buildHarness()
    await bindAccount(harness)
    await harness.module.handleInbound(harness.inbound({ text: '/save apple' }))
    await waitForReply(harness, (text) => text === 'vocab-feedback:saved=1,existing=0')
    // 模拟崩溃窗口：词库已提交、渠道回复未落盘、入站停在执行中。
    const record = harness.store.inbound.find((item) => item.text === '/save apple')!
    harness.store.replies.length = 0
    harness.store.updateInbound(
      record.inboundId,
      { status: 'executing' },
      '2026-09-23T12:01:00.000Z'
    )
    harness.transport.sent.length = 0

    const restarted = restart(harness)
    await restarted.module.recover()
    await waitForReply(restarted, (text) => text === 'vocab-feedback:saved=1,existing=0')
    // 不重新执行收藏：词库写入仍只有一次。
    expect(harness.vocabularyRepository.commands).toHaveLength(1)
    expect(harness.store.inbound.find((item) => item.text === '/save apple')?.status).toBe(
      'succeeded'
    )
  })

  it('marks executing conversation work without an assistant reply as failed with guidance', async () => {
    const harness = buildHarness()
    await bindAccount(harness)
    // 制造一条有 executionRef 但没有 assistant 回复的会话记录。
    await harness.module.handleInbound(harness.inbound({ text: 'lost question' }))
    await waitForReply(harness, (text) => text === 'assistant:lost question')
    const record = harness.store.inbound.find((item) => item.text === 'lost question')!
    const messages = harness.conversationRepository.messages.filter(
      (m) => m.sessionId === record.sessionId
    )
    const userMessage = messages.find((m) => m.role === 'user')!
    harness.conversationRepository.messages.splice(
      harness.conversationRepository.messages.findIndex((m) => m.id === messages.at(-1)!.id),
      1
    )
    void userMessage
    harness.store.replies.length = 0
    harness.store.updateInbound(
      record.inboundId,
      { status: 'executing' },
      '2026-09-23T12:01:00.000Z'
    )
    harness.transport.sent.length = 0

    const restarted = restart(harness)
    await restarted.module.recover()
    await waitForReply(restarted, (text) => text === 'executionFailed[zh-CN]')
    expect(harness.store.inbound.find((item) => item.text === 'lost question')?.status).toBe(
      'failed'
    )
  })

  it('invalidates stale confirmations on restart', async () => {
    const harness = buildHarness({
      recognize: async () => ({ status: 'save', words: ['apple'] })
    })
    await bindAccount(harness)
    await harness.module.handleInbound(harness.inbound({ text: '帮我记住 apple' }))
    await waitForReply(harness, (text) => text.startsWith('confirmationPrompt['))

    const restarted = restart(harness)
    await restarted.module.recover()
    expect(harness.store.confirmations[0].consumedAt).not.toBeNull()
    await restarted.module.handleInbound(restarted.inbound({ text: '/confirm' }))
    await waitForReply(restarted, (text) => text === 'confirmNoPending[zh-CN]')
    expect(harness.vocabularyRepository.commands).toHaveLength(0)
  })
})

describe('Channel account rate limits', () => {
  it.each(['/save banana', '/confirm invalid'])(
    'rate limits %s after exhausting the shared budget',
    async (text) => {
      const harness = buildHarness({ policies: { accountRateMaxMessages: 1 } })
      await bindAccount(harness)
      await harness.module.handleInbound(harness.inbound({ text: '/save apple' }))
      await waitForReply(harness, (reply) => reply.startsWith('vocab-feedback:'))
      await harness.module.handleInbound(harness.inbound({ text }))
      await waitForReply(harness, (reply) => reply === 'rateLimited[zh-CN]')
      expect(harness.vocabularyRepository.commands).toHaveLength(1)
      await harness.module.handleInbound(harness.inbound({ text: '/cancel' }))
      await waitForReply(harness, (reply) => reply === 'cancelIdle[zh-CN]')
    }
  )
})

describe('Channel intent failure', () => {
  it('reports recognition failure without starting a conversation or saving', async () => {
    const harness = buildHarness({
      recognize: async () => {
        throw new Error('invalid tool response')
      }
    })
    await bindAccount(harness)
    await harness.module.handleInbound(harness.inbound({ text: 'remember apple' }))
    await waitForReply(harness, (reply) => reply === 'executionFailed[zh-CN]')
    expect(conversationCalls(harness.model)).toHaveLength(0)
    expect(harness.vocabularyRepository.commands).toHaveLength(0)
    expect(harness.store.inbound.at(-1)?.status).toBe('failed')
  })
})

describe('Channel delivery concurrency', () => {
  it('does not resend a reply while its initial delivery is still pending', async () => {
    const harness = buildHarness()
    await bindAccount(harness)
    let finish!: (outcome: { delivered: boolean }) => void
    const send = vi.spyOn(harness.transport, 'send').mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    await harness.module.handleInbound(harness.inbound({ text: '/save apple' }))
    await vi.waitFor(() => expect(send).toHaveBeenCalledOnce())
    const retry = harness.module.deliverPendingReplies()
    await Promise.resolve()
    expect(send).toHaveBeenCalledOnce()
    finish({ delivered: true })
    await retry
    await vi.waitFor(() => expect(harness.store.replies.at(-1)?.status).toBe('sent'))
    await harness.module.deliverPendingReplies()
    expect(send).toHaveBeenCalledOnce()
  })
})
