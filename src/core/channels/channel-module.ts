import { randomUUID } from 'node:crypto'
import { noopCoreDiagnostics, type CoreDiagnostics } from '../error-diagnostics'
import type {
  ConversationEventListener,
  ConversationModule,
  ConversationLanguages
} from '../conversation/conversation-module'
import type { ConversationRepository } from '../conversation/conversation-repository'
import type { ConversationSkillRepository } from '../conversation/conversation-skill-repository'
import type { ConversationSkill } from '../conversation/conversation-skill'
import type { ConversationEvent, ConversationSkillId } from '../../shared/conversation'
import { DEFAULT_CHANNEL_POLICIES, type ChannelPolicies } from './channel-policies'
import { ChannelError } from './channel-errors'
import type { ChannelStore } from './channel-store'
import type {
  ChatChannelReplies,
  ChannelIntentResult,
  ChannelIntentRecognizer,
  IgnoredChannelEvent,
  StoredChannelBinding,
  ChannelOutboundTarget,
  ChannelTransport,
  InboundChannelMessage,
  StoredChannelInbound,
  ChannelInboundStatus,
  StoredChannelReply
} from './channel-types'
import { channelSessionKey } from './channel-types'

export interface ChannelModuleDependencies {
  store: ChannelStore
  conversations: ConversationModule
  // 渠道会话的持久化后端：与桌面对话隔离，恢复逻辑用它核对提交记录。
  conversationStore: ConversationRepository & ConversationSkillRepository
  skills: ReadonlyMap<ConversationSkillId, ConversationSkill>
  intentRecognizer: ChannelIntentRecognizer
  replies: ChatChannelReplies
  transport: ChannelTransport
  resolveLanguages: () => ConversationLanguages
  policies?: Partial<ChannelPolicies>
  now?: () => Date
  generateId?: () => string
  diagnostics?: CoreDiagnostics
  // 平台侧发起绑定请求后通知（Main 推送设置页刷新）；仅在持久化成功后调用。
  onBindingRequested?: () => void
}

// 远程能力白名单：命令分派只接受 start/help/save/new/cancel/confirm，
// 其余命令不执行；不允许任意文件、SQL、系统命令、模型配置修改或远程删除。

interface ParsedCommand {
  name: string
  rest: string
}

function parseCommand(text: string): ParsedCommand | undefined {
  const match = /^\/([a-zA-Z]+)(?:@\w+)?(?:\s+([\s\S]*))?$/.exec(text.trim())
  if (!match) return undefined
  return { name: match[1].toLowerCase(), rest: (match[2] ?? '').trim() }
}

// 绑定码字母表：去除易混淆字符（I/O/0/1/L），6 位短时有效、一次性。
const BINDING_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
const BINDING_CODE_LENGTH = 6

function generateBindingCode(random: () => number): string {
  let code = ''
  for (let index = 0; index < BINDING_CODE_LENGTH; index += 1) {
    code += BINDING_CODE_ALPHABET[Math.floor(random() * BINDING_CODE_ALPHABET.length)]
  }
  return code
}

// 会话内待执行工作：接收循环与 Agent 执行解耦，同一会话串行执行。
interface QueuedWork {
  inboundId: string
  message: InboundChannelMessage
  kind: 'save' | 'message' | 'confirm'
  text: string
}

interface RunningExecution {
  inboundId: string
  requestId: string
  sessionKey: string
  controller: AbortController
  launched: boolean
}

interface SessionRuntime {
  connectionId: string
  queue: QueuedWork[]
  running: RunningExecution | null
}

type TerminalEvent = Extract<ConversationEvent, { type: 'completed' | 'cancelled' | 'failed' }>

// 终态事件（completed/cancelled/failed 三者之一）是渠道侧等待执行完成的点。
function terminalOf(event: ConversationEvent): TerminalEvent | undefined {
  if (event.type === 'completed' || event.type === 'cancelled' || event.type === 'failed') {
    return event
  }
  return undefined
}

export class ChannelModule {
  private readonly policies: ChannelPolicies
  private readonly now: () => Date
  private readonly generateId: () => string
  private readonly diagnostics: CoreDiagnostics
  private readonly sessions = new Map<string, SessionRuntime>()
  private readonly rateWindow = new Map<string, number[]>()
  private disposed = false
  private readonly deliveringReplies = new Set<string>()
  private drainingReplies = false

  constructor(private readonly deps: ChannelModuleDependencies) {
    this.policies = { ...DEFAULT_CHANNEL_POLICIES, ...deps.policies }
    this.now = deps.now ?? (() => new Date())
    this.generateId = deps.generateId ?? randomUUID
    this.diagnostics = deps.diagnostics ?? noopCoreDiagnostics
  }

  // 不支持或未授权事件的忽略标记：安全推进游标，不保存正文。
  noteIgnored(event: IgnoredChannelEvent): void {
    const timestamp = this.now().toISOString()
    this.deps.store.recordInbound({
      inboundId: this.generateId(),
      connectionId: event.connectionId,
      platform: event.platform,
      botId: event.botId,
      eventId: event.eventId,
      messageId: 0,
      chatId: '',
      senderId: '',
      sentAt: timestamp,
      receivedAt: timestamp,
      text: null,
      kind: 'ignored',
      status: 'ignored',
      sessionId: null,
      executionRef: null,
      createdAt: timestamp,
      updatedAt: timestamp
    })
  }

  // 入站消息入口：幂等落盘、过期检查、绑定鉴权与命令分派。
  // 接收循环与 Agent 执行解耦：执行类工作进入会话队列后立即返回。
  async handleInbound(message: InboundChannelMessage): Promise<void> {
    const binding = this.deps.store.findActiveBindingBySender(
      message.connectionId,
      message.senderId
    )
    const command = parseCommand(message.text)
    // 未绑定发送者不保留正文；/start 绑定命令除外（码本身短时有效）。
    const authorized = binding !== undefined || command?.name === 'start'
    const timestamp = this.now().toISOString()
    const record: StoredChannelInbound = {
      inboundId: this.generateId(),
      connectionId: message.connectionId,
      platform: message.platform,
      botId: message.botId,
      eventId: message.eventId,
      messageId: message.messageId,
      chatId: message.chatId,
      senderId: message.senderId,
      sentAt: message.sentAt,
      receivedAt: message.receivedAt,
      text: authorized ? message.text : null,
      kind: command ? 'command' : 'message',
      status: 'received',
      sessionId: null,
      executionRef: null,
      createdAt: timestamp,
      updatedAt: timestamp
    }
    if (!this.deps.store.recordInbound(record).created) return

    // 积压消息有效期：过期请求不自动执行，需用户重新发起。
    if (this.isExpired(message.sentAt)) {
      this.deps.store.updateInbound(record.inboundId, { status: 'expired' }, timestamp)
      return
    }

    // /start 绑定命令自行处理已绑定场景（alreadyBound），不走会话执行。
    if (command?.name === 'start') {
      await this.handleBindingCommand(message, record.inboundId)
      return
    }

    if (!binding) {
      // 未绑定账号不能访问模型、词库或会话。
      this.deps.store.updateInbound(record.inboundId, { status: 'ignored' }, timestamp)
      await this.deliverNow(this.target(message), this.deps.replies.notBound(this.outputLanguage()))
      return
    }

    await this.dispatchBound(message, record.inboundId, command)
  }

  private isExpired(sentAt: string): boolean {
    return Date.parse(sentAt) + this.policies.inboundMessageTtlMs < this.now().getTime()
  }

  private target(message: InboundChannelMessage): ChannelOutboundTarget {
    return {
      platform: message.platform,
      connectionId: message.connectionId,
      botId: message.botId,
      chatId: message.chatId
    }
  }

  // 控制类回复直接投递；结果类回复必须先落盘再经出站记录投递。
  private async deliverNow(target: ChannelOutboundTarget, text: string): Promise<void> {
    try {
      await this.deps.transport.send(target, text)
    } catch (error) {
      this.diagnostics.report({
        level: 'warn',
        module: 'channels',
        operation: 'deliver',
        message: 'channel control reply delivery failed',
        error
      })
    }
  }

  private outputLanguage(): ConversationLanguages['outputLanguage'] {
    return this.deps.resolveLanguages().outputLanguage
  }

  private async handleBindingCommand(
    message: InboundChannelMessage,
    inboundId: string
  ): Promise<void> {
    const language = this.outputLanguage()
    const timestamp = this.now().toISOString()
    if (this.deps.store.findActiveBindingBySender(message.connectionId, message.senderId)) {
      this.deps.store.updateInbound(inboundId, { status: 'ignored' }, timestamp)
      await this.deliverNow(this.target(message), this.deps.replies.alreadyBound(language))
      return
    }
    const code = parseCommand(message.text)?.rest ?? ''
    const outcome = code
      ? this.deps.store.matchBindingCode(message.connectionId, code, timestamp)
      : 'none'
    if (outcome === 'matched') {
      this.deps.store.insertPendingBinding({
        bindingId: this.generateId(),
        connectionId: message.connectionId,
        platform: message.platform,
        senderId: message.senderId,
        chatId: message.chatId,
        displayName: message.senderName,
        status: 'pending',
        requestedAt: timestamp,
        confirmedAt: null,
        unboundAt: null
      })
      this.deps.store.updateInbound(inboundId, { status: 'succeeded' }, timestamp)
      this.deps.onBindingRequested?.()
      await this.deliverNow(this.target(message), this.deps.replies.bindingRequested(language))
      return
    }
    const replyByOutcome = {
      mismatch: this.deps.replies.bindingCodeMismatch(language),
      expired: this.deps.replies.bindingCodeExpired(language),
      exhausted: this.deps.replies.bindingCodeExhausted(language),
      none: this.deps.replies.noActiveBindingCode(language)
    } as const
    this.deps.store.updateInbound(inboundId, { status: 'ignored' }, timestamp)
    await this.deliverNow(this.target(message), replyByOutcome[outcome])
  }

  // 桌面侧签发绑定码：短时有效、一次性；新码替换未消费的旧码。
  async issueBindingCode(): Promise<{ code: string; expiresAt: string }> {
    const connection = this.deps.store.findSoleConnection()
    if (!connection) throw new ChannelError('NO_CONNECTION')
    const now = this.now()
    const code = generateBindingCode(Math.random)
    const expiresAt = new Date(now.getTime() + this.policies.bindingCodeTtlMs).toISOString()
    this.deps.store.saveBindingCode({
      connectionId: connection.connectionId,
      code,
      createdAt: now.toISOString(),
      expiresAt,
      consumedAt: null,
      attempts: 0
    })
    return { code, expiresAt }
  }

  // 桌面侧确认绑定请求：核对平台与账号后激活。
  async confirmPendingBinding(): Promise<StoredChannelBinding> {
    const connection = this.deps.store.findSoleConnection()
    if (!connection) throw new ChannelError('NO_CONNECTION')
    const pending = this.deps.store.findPendingBinding(connection.connectionId)
    if (!pending) throw new ChannelError('NO_PENDING_BINDING_REQUEST')
    const binding = this.deps.store.confirmPendingBinding(
      pending.bindingId,
      this.now().toISOString()
    )
    if (!binding) throw new ChannelError('NO_PENDING_BINDING_REQUEST')
    return binding
  }

  // 桌面侧拒绝绑定请求。
  rejectPendingBinding(): void {
    const connection = this.deps.store.findSoleConnection()
    if (!connection) throw new ChannelError('NO_CONNECTION')
    const pending = this.deps.store.findPendingBinding(connection.connectionId)
    if (!pending) throw new ChannelError('NO_PENDING_BINDING_REQUEST')
    this.deps.store.rejectPendingBinding(pending.bindingId)
  }

  // ---- 绑定后的命令分派 ----

  private async dispatchBound(
    message: InboundChannelMessage,
    inboundId: string,
    command: ParsedCommand | undefined
  ): Promise<void> {
    const language = this.outputLanguage()
    const timestamp = this.now().toISOString()
    const text = message.text.trim()
    if (!text) {
      this.deps.store.updateInbound(inboundId, { status: 'ignored' }, timestamp)
      return
    }
    if (text.length > this.policies.inboundMaxLength) {
      this.deps.store.updateInbound(inboundId, { status: 'ignored' }, timestamp)
      await this.deliverNow(this.target(message), this.deps.replies.messageTooLong(language))
      return
    }
    if (
      (!command || command.name === 'save' || command.name === 'confirm') &&
      !this.allowRate(message.senderId)
    ) {
      this.deps.store.updateInbound(inboundId, { status: 'ignored' }, timestamp)
      await this.deliverNow(this.target(message), this.deps.replies.rateLimited(language))
      return
    }
    if (command) {
      if (command.name === 'help') {
        this.deps.store.updateInbound(inboundId, { status: 'succeeded' }, timestamp)
        await this.deliverNow(this.target(message), this.deps.replies.help(language))
        return
      }
      if (command.name === 'cancel') {
        await this.handleCancelCommand(message, inboundId)
        return
      }
      if (command.name === 'new') {
        await this.handleNewCommand(message, inboundId)
        return
      }
      if (command.name === 'confirm') {
        this.enqueueWork(message, inboundId, { kind: 'confirm', text: command.rest })
        return
      }
      if (command.name === 'save') {
        if (!command.rest) {
          this.deps.store.updateInbound(inboundId, { status: 'ignored' }, timestamp)
          await this.deliverNow(this.target(message), this.deps.replies.help(language))
          return
        }
        this.enqueueWork(message, inboundId, { kind: 'save', text: command.rest })
        return
      }
      // 白名单之外的命令不执行，回复帮助指引。
      this.deps.store.updateInbound(inboundId, { status: 'ignored' }, timestamp)
      await this.deliverNow(this.target(message), this.deps.replies.help(language))
      return
    }
    this.enqueueWork(message, inboundId, { kind: 'message', text })
  }

  private allowRate(senderId: string): boolean {
    const at = this.now().getTime()
    const stamps = (this.rateWindow.get(senderId) ?? []).filter(
      (stamp) => at - stamp < this.policies.accountRateWindowMs
    )
    if (stamps.length >= this.policies.accountRateMaxMessages) {
      this.rateWindow.set(senderId, stamps)
      return false
    }
    stamps.push(at)
    this.rateWindow.set(senderId, stamps)
    return true
  }

  // ---- 会话队列：同一外部会话串行执行，接收不被模型阻塞 ----

  private enqueueWork(
    message: InboundChannelMessage,
    inboundId: string,
    work:
      | { kind: 'save'; text: string }
      | { kind: 'message'; text: string }
      | { kind: 'confirm'; text: string }
  ): void {
    const sessionKey = channelSessionKey(message)
    const state = this.sessions.get(sessionKey) ?? {
      connectionId: message.connectionId,
      queue: [],
      running: null
    }
    this.sessions.set(sessionKey, state)
    if (state.queue.length >= this.policies.sessionQueueLimit) {
      this.deps.store.updateInbound(inboundId, { status: 'failed' }, this.now().toISOString())
      void this.deliverNow(this.target(message), this.deps.replies.queueBusy(this.outputLanguage()))
      return
    }
    state.queue.push({
      inboundId,
      message,
      kind: work.kind,
      text: work.text
    })
    void this.runNext(sessionKey, message.connectionId)
  }

  private sessionRuntime(sessionKey: string, connectionId: string): SessionRuntime {
    const existing = this.sessions.get(sessionKey)
    if (existing) return existing
    const state: SessionRuntime = { connectionId, queue: [], running: null }
    this.sessions.set(sessionKey, state)
    return state
  }

  private async runNext(sessionKey: string, connectionId: string): Promise<void> {
    const state = this.sessionRuntime(sessionKey, connectionId)
    if (state.running || state.queue.length === 0 || this.disposed) return
    const work = state.queue.shift()!
    const requestId = this.generateId()
    state.running = {
      inboundId: work.inboundId,
      requestId,
      sessionKey,
      controller: new AbortController(),
      launched: false
    }
    try {
      await this.executeWork(sessionKey, work, requestId)
    } catch (error) {
      if (state.running?.controller.signal.aborted) return
      // 未预期异常收敛为失败状态与安全反馈，不让队列卡死。
      this.diagnostics.report({
        level: 'error',
        module: 'channels',
        operation: 'execute',
        message: 'channel execution failed unexpectedly',
        error
      })
      await this.persistAndDeliver(
        work.message,
        work.inboundId,
        null,
        this.deps.replies.executionFailed(this.outputLanguage()),
        'failed'
      )
    } finally {
      state.running = null
      if (state.queue.length > 0) void this.runNext(sessionKey, state.connectionId)
    }
  }

  private async executeWork(
    sessionKey: string,
    work: QueuedWork,
    requestId: string
  ): Promise<void> {
    const { message, inboundId } = work
    const languages = this.deps.resolveLanguages()
    if (work.kind === 'confirm') {
      await this.executeConfirmation(sessionKey, work, requestId)
      return
    }
    if (work.kind === 'message') {
      const intent = await this.recognizeIntent(work.text, sessionKey)
      if (!this.canExecute(sessionKey, message)) return
      if (intent.status === 'save') {
        await this.requestSaveConfirmation(sessionKey, work, intent.words)
        return
      }
      if (intent.status === 'clarify') {
        await this.persistAndDeliver(
          message,
          inboundId,
          null,
          this.deps.replies.intentClarify(languages.outputLanguage),
          'succeeded'
        )
        return
      }
    }
    if (!this.canExecute(sessionKey, message)) return
    await this.executeConversationOrSave(sessionKey, work, requestId, work.kind === 'save')
  }

  private canExecute(sessionKey: string, message: InboundChannelMessage): boolean {
    const running = this.sessions.get(sessionKey)?.running
    if (!running || running.controller.signal.aborted || this.disposed) return false
    if (this.isExpired(message.sentAt)) {
      this.deps.store.updateInbound(
        running.inboundId,
        { status: 'expired' },
        this.now().toISOString()
      )
      return false
    }
    if (!this.deps.store.findActiveBindingBySender(message.connectionId, message.senderId)) {
      this.deps.store.updateInbound(
        running.inboundId,
        { status: 'ignored' },
        this.now().toISOString()
      )
      return false
    }
    return true
  }

  private async recognizeIntent(text: string, sessionKey: string): Promise<ChannelIntentResult> {
    const languages = this.deps.resolveLanguages()
    const signal = this.sessions.get(sessionKey)!.running!.controller.signal
    return this.deps.intentRecognizer.recognize({
      text,
      outputLanguage: languages.outputLanguage,
      targetLanguage: languages.targetLanguage,
      signal
    })
  }

  private async executeConversationOrSave(
    sessionKey: string,
    work: QueuedWork,
    requestId: string,
    save: boolean
  ): Promise<void> {
    const { message, inboundId, text } = work
    if (!this.canExecute(sessionKey, message)) return
    const languages = this.deps.resolveLanguages()
    let resolveTerminal!: (terminal: TerminalEvent) => void
    const terminalPromise = new Promise<TerminalEvent>((resolve) => {
      resolveTerminal = resolve
    })
    const forwardingEmit: ConversationEventListener = (event) => {
      const terminal = terminalOf(event)
      if (terminal) resolveTerminal(terminal)
    }
    const userMessageId = this.generateId()
    const launch = async (sessionId: string): Promise<void> => {
      if (save) {
        await this.deps.conversations.runSkill(
          {
            requestId,
            sessionId,
            skillId: 'vocabulary',
            arguments: { text, wordLanguage: languages.targetLanguage }
          },
          forwardingEmit,
          { userMessageId }
        )
        return
      }
      await this.deps.conversations.sendMessage({ requestId, sessionId, text }, forwardingEmit, {
        userMessageId
      })
    }
    const sessionId = await this.ensureSession(sessionKey, message)
    if (!this.canExecute(sessionKey, message)) return
    this.deps.store.updateInbound(
      inboundId,
      { status: 'executing', sessionId, executionRef: { requestId, userMessageId } },
      this.now().toISOString()
    )
    try {
      this.sessions.get(sessionKey)!.running!.launched = true
      await launch(sessionId)
    } catch (error) {
      await this.handleLaunchFailure(message, inboundId, sessionId, error)
      return
    }
    const terminal = await terminalPromise
    await this.finishExecution(message, inboundId, sessionId, terminal)
  }

  private async handleLaunchFailure(
    message: InboundChannelMessage,
    inboundId: string,
    sessionId: string,
    error: unknown
  ): Promise<void> {
    this.diagnostics.report({
      level: 'error',
      module: 'channels',
      operation: 'launch',
      message: 'channel generation launch failed',
      error
    })
    await this.persistAndDeliver(
      message,
      inboundId,
      sessionId,
      this.deps.replies.executionFailed(this.outputLanguage()),
      'failed'
    )
  }

  private async finishExecution(
    message: InboundChannelMessage,
    inboundId: string,
    sessionId: string,
    terminal: TerminalEvent
  ): Promise<void> {
    const language = this.outputLanguage()
    const timestamp = this.now().toISOString()
    if (terminal.type === 'completed') {
      await this.persistAndDeliver(
        message,
        inboundId,
        sessionId,
        terminal.message.content,
        'succeeded'
      )
      return
    }
    if (terminal.type === 'cancelled') {
      // 取消反馈由 /cancel 控制路径负责；这里只收敛状态。
      this.deps.store.updateInbound(inboundId, { status: 'cancelled' }, timestamp)
      return
    }
    await this.persistAndDeliver(
      message,
      inboundId,
      sessionId,
      this.deps.replies.executionFailed(language),
      'failed'
    )
  }

  // ---- 自然语言收藏确认 ----

  private async requestSaveConfirmation(
    sessionKey: string,
    work: QueuedWork,
    words: string[]
  ): Promise<void> {
    const { message, inboundId } = work
    const languages = this.deps.resolveLanguages()
    const timestamp = this.now().toISOString()
    const sessionId = await this.ensureSession(sessionKey, message)
    if (!this.canExecute(sessionKey, message)) return
    const operationId = this.generateId()
    // 保存时替换该会话已有的活动确认（每会话至多一个）。
    this.deps.store.saveConfirmation({
      operationId,
      connectionId: message.connectionId,
      sessionId,
      chatId: message.chatId,
      senderId: message.senderId,
      messageRef: message.messageId,
      words,
      targetLanguage: languages.targetLanguage,
      explanationLanguage: languages.outputLanguage,
      createdAt: timestamp,
      expiresAt: new Date(this.now().getTime() + this.policies.confirmationTtlMs).toISOString(),
      consumedAt: null
    })
    await this.persistAndDeliver(
      message,
      inboundId,
      sessionId,
      this.deps.replies.confirmationPrompt(languages.outputLanguage, {
        words,
        targetLanguage: languages.targetLanguage,
        operationId
      }),
      'pending_confirmation'
    )
  }

  private async executeConfirmation(
    sessionKey: string,
    work: QueuedWork,
    requestId: string
  ): Promise<void> {
    const { message, inboundId } = work
    const languages = this.deps.resolveLanguages()
    const sessionId = await this.ensureSession(sessionKey, message)
    if (!this.canExecute(sessionKey, message)) return
    const scope = {
      connectionId: message.connectionId,
      sessionId,
      chatId: message.chatId,
      senderId: message.senderId
    }
    const confirmation = this.deps.store.findActiveConfirmation(scope)
    if (!confirmation || confirmation.operationId !== work.text) {
      await this.persistAndDeliver(
        message,
        inboundId,
        sessionId,
        this.deps.replies.confirmNoPending(languages.outputLanguage),
        'ignored'
      )
      return
    }
    if (Date.parse(confirmation.expiresAt) <= this.now().getTime()) {
      this.deps.store.invalidateSessionConfirmation(scope)
      await this.persistAndDeliver(
        message,
        inboundId,
        sessionId,
        this.deps.replies.confirmExpired(languages.outputLanguage),
        'ignored'
      )
      return
    }
    // 确认时目标语言已变化：按新快照重新确认，不直接写入。
    if (confirmation.targetLanguage !== languages.targetLanguage) {
      const operationId = this.generateId()
      this.deps.store.saveConfirmation({
        ...confirmation,
        operationId,
        words: confirmation.words,
        targetLanguage: languages.targetLanguage,
        explanationLanguage: languages.outputLanguage,
        createdAt: this.now().toISOString(),
        expiresAt: new Date(this.now().getTime() + this.policies.confirmationTtlMs).toISOString(),
        consumedAt: null
      })
      await this.persistAndDeliver(
        message,
        inboundId,
        sessionId,
        this.deps.replies.confirmLanguageChanged(languages.outputLanguage, {
          words: confirmation.words,
          targetLanguage: languages.targetLanguage,
          operationId
        }),
        'pending_confirmation'
      )
      return
    }
    const consumed = this.deps.store.consumeConfirmation(
      confirmation.operationId,
      this.now().toISOString()
    )
    if (consumed.outcome !== 'consumed') {
      await this.persistAndDeliver(
        message,
        inboundId,
        sessionId,
        this.deps.replies.confirmExpired(languages.outputLanguage),
        'ignored'
      )
      return
    }
    // 归属与快照校验通过后按词条快照执行收藏。
    await this.executeConversationOrSave(
      sessionKey,
      { ...work, kind: 'save', text: consumed.confirmation.words.join(', ') },
      requestId,
      true
    )
  }

  // ---- 控制命令 ----

  private async handleCancelCommand(
    message: InboundChannelMessage,
    inboundId: string
  ): Promise<void> {
    const language = this.outputLanguage()
    const sessionKey = channelSessionKey(message)
    const state = this.sessions.get(sessionKey)
    const sessionId = this.deps.store.findActiveSessionId(sessionKey)
    const scope = {
      connectionId: message.connectionId,
      sessionId: sessionId ?? '',
      chatId: message.chatId,
      senderId: message.senderId
    }
    let cancelled = 0
    if (state) {
      if (state.running) {
        state.running.controller.abort()
        this.deps.store.updateInbound(
          state.running.inboundId,
          { status: 'cancelled' },
          this.now().toISOString()
        )
        try {
          if (state.running.launched) this.deps.conversations.cancelMessage(state.running.requestId)
          cancelled += 1
        } catch (error) {
          if (!isRequestNotFound(error)) throw error
        }
      }
      for (const queued of state.queue) {
        this.deps.store.updateInbound(
          queued.inboundId,
          { status: 'cancelled' },
          this.now().toISOString()
        )
        cancelled += 1
      }
      state.queue = []
    }
    let invalidatedConfirmation = false
    if (sessionId) {
      invalidatedConfirmation = this.deps.store.findActiveConfirmation(scope) !== undefined
      this.deps.store.invalidateSessionConfirmation(scope)
    }
    if (cancelled === 0 && !invalidatedConfirmation) {
      this.deps.store.updateInbound(inboundId, { status: 'succeeded' }, this.now().toISOString())
      await this.deliverNow(this.target(message), this.deps.replies.cancelIdle(language))
      return
    }
    this.deps.store.updateInbound(inboundId, { status: 'succeeded' }, this.now().toISOString())
    await this.deliverNow(
      this.target(message),
      this.deps.replies.cancelReport(language, { cancelled })
    )
  }

  private async handleNewCommand(message: InboundChannelMessage, inboundId: string): Promise<void> {
    const language = this.outputLanguage()
    const sessionKey = channelSessionKey(message)
    const state = this.sessions.get(sessionKey)
    const sessionId = this.deps.store.findActiveSessionId(sessionKey)
    const busy =
      (state?.running !== null && state?.running !== undefined) ||
      (state?.queue.length ?? 0) > 0 ||
      (sessionId
        ? this.deps.store.findActiveConfirmation({
            connectionId: message.connectionId,
            sessionId,
            chatId: message.chatId,
            senderId: message.senderId
          }) !== undefined
        : false)
    if (busy) {
      this.deps.store.updateInbound(inboundId, { status: 'ignored' }, this.now().toISOString())
      await this.deliverNow(this.target(message), this.deps.replies.newSessionBusy(language))
      return
    }
    const summary = await this.deps.conversations.createConversation()
    this.deps.store.createSession({
      sessionId: summary.sessionId,
      connectionId: message.connectionId,
      sessionKey,
      createdAt: this.now().toISOString(),
      updatedAt: this.now().toISOString()
    })
    this.deps.store.updateInbound(inboundId, { status: 'succeeded' }, this.now().toISOString())
    await this.deliverNow(this.target(message), this.deps.replies.newSessionStarted(language))
  }

  // ---- 会话与出站 ----

  private async ensureSession(sessionKey: string, message: InboundChannelMessage): Promise<string> {
    const existingId = this.deps.store.findActiveSessionId(sessionKey)
    if (existingId) return existingId
    return this.createNewSession(sessionKey, message)
  }

  // 新会话先以草稿存在，首条消息落库时持久化；外部消息不能指定桌面 sessionId。
  private async createNewSession(
    sessionKey: string,
    message: InboundChannelMessage
  ): Promise<string> {
    const summary = await this.deps.conversations.createConversation()
    const timestamp = this.now().toISOString()
    this.deps.store.createSession({
      sessionId: summary.sessionId,
      connectionId: message.connectionId,
      sessionKey,
      createdAt: timestamp,
      updatedAt: timestamp
    })
    return summary.sessionId
  }

  // 结果类回复：先持久化待发记录，再投递；投递失败保留记录等待重试。
  private async persistAndDeliver(
    message: InboundChannelMessage,
    inboundId: string,
    sessionId: string | null,
    text: string,
    status: ChannelInboundStatus
  ): Promise<void> {
    const timestamp = this.now().toISOString()
    const reply: StoredChannelReply = {
      replyId: this.generateId(),
      connectionId: message.connectionId,
      platform: message.platform,
      chatId: message.chatId,
      senderId: message.senderId,
      sessionId,
      inboundId,
      text,
      status: 'pending',
      attempts: 0,
      createdAt: timestamp,
      updatedAt: timestamp,
      sentAt: null
    }
    this.deps.store.saveResult(inboundId, status, reply)
    await this.attemptDelivery(reply)
  }

  private async attemptDelivery(reply: StoredChannelReply): Promise<void> {
    if (this.deliveringReplies.has(reply.replyId)) return
    // A queued retry may have been sent or invalidated since the batch was read.
    const pending = this.deps.store
      .listPendingReplies(reply.connectionId)
      .find((candidate) => candidate.replyId === reply.replyId)
    if (!pending) return
    this.deliveringReplies.add(reply.replyId)
    try {
      await this.sendPendingReply(pending)
    } finally {
      this.deliveringReplies.delete(reply.replyId)
    }
  }

  private async sendPendingReply(reply: StoredChannelReply): Promise<void> {
    // 每次投递前重新校验绑定：解绑后的未发送回复不再投递。
    if (!this.deps.store.findActiveBindingBySender(reply.connectionId, reply.senderId)) {
      this.deps.store.markReplyAttemptFailed(reply.replyId, this.now().toISOString(), 'failed')
      return
    }
    if (Date.parse(reply.createdAt) + this.policies.replyTtlMs <= this.now().getTime()) {
      this.deps.store.markReplyAttemptFailed(reply.replyId, this.now().toISOString(), 'failed')
      return
    }
    let outcome: { delivered: boolean; deferred?: boolean }
    try {
      outcome = await this.deps.transport.send(
        {
          platform: reply.platform,
          connectionId: reply.connectionId,
          botId: this.deps.store.findConnection(reply.connectionId)?.botId ?? '',
          chatId: reply.chatId
        },
        reply.text
      )
    } catch (error) {
      this.diagnostics.report({
        level: 'warn',
        module: 'channels',
        operation: 'deliver',
        message: 'channel reply delivery threw',
        error
      })
      outcome = { delivered: false }
    }
    if (outcome.delivered) {
      this.deps.store.markReplySent(reply.replyId, this.now().toISOString())
      return
    }
    if (outcome.deferred) return
    const nextStatus = reply.attempts + 1 >= this.policies.replyMaxAttempts ? 'failed' : 'pending'
    this.deps.store.markReplyAttemptFailed(reply.replyId, this.now().toISOString(), nextStatus)
  }

  // 桌面侧解绑：停止该账号任务、取消运行及排队任务、作废确认和未发送回复；
  // 已经提交的收藏不回滚。
  async unbind(): Promise<void> {
    const connection = this.deps.store.findSoleConnection()
    if (!connection) throw new ChannelError('NO_CONNECTION')
    const binding = this.deps.store.findActiveBinding(connection.connectionId)
    if (!binding) throw new ChannelError('NO_ACTIVE_BINDING')
    this.cancelConnectionWork(connection.connectionId)
    this.deps.store.invalidateConfirmationsForOwner(
      connection.connectionId,
      binding.senderId,
      binding.chatId
    )
    this.deps.store.markBindingUnbound(connection.connectionId, this.now().toISOString())
    this.deps.store.dropPendingReplies(connection.connectionId)
  }

  // 断开连接：取消运行及排队任务并暂停投递；重新连接后只补发仍授权的已完成结果。
  pauseConnection(): void {
    const connection = this.deps.store.findSoleConnection()
    if (!connection) return
    this.cancelConnectionWork(connection.connectionId)
  }

  // 取消连接下全部运行与排队任务；运行中请求经取消控制路径立即中止。
  private cancelConnectionWork(connectionId: string): void {
    for (const state of this.sessions.values()) {
      if (state.connectionId !== connectionId) continue
      if (state.running) {
        state.running.controller.abort()
        try {
          if (state.running.launched) this.deps.conversations.cancelMessage(state.running.requestId)
        } catch (error) {
          if (!isRequestNotFound(error)) throw error
        }
        this.deps.store.updateInbound(
          state.running.inboundId,
          { status: 'cancelled' },
          this.now().toISOString()
        )
      }
      for (const queued of state.queue) {
        this.deps.store.updateInbound(
          queued.inboundId,
          { status: 'cancelled' },
          this.now().toISOString()
        )
      }
      state.queue = []
    }
  }

  // 启动恢复：核对提交记录、收敛执行状态、失效旧确认、重派未执行任务，
  // 最后补发仍授权的待发回复；不盲目重跑任何写入操作。
  async recover(): Promise<void> {
    const connection = this.deps.store.findSoleConnection()
    if (!connection) return
    // 重启后旧确认失效：不能凭旧快照继续写入。
    this.deps.store.invalidateAllConfirmations(connection.connectionId)
    for (const record of this.deps.store.listRecoverableInbound(connection.connectionId)) {
      await this.recoverInbound(record)
    }
    await this.deliverPendingReplies()
  }

  private async recoverInbound(record: StoredChannelInbound): Promise<void> {
    const timestamp = this.now().toISOString()
    if (record.status === 'pending_confirmation') {
      // 重启后旧确认失效；用户可重新发起。
      this.deps.store.updateInbound(record.inboundId, { status: 'expired' }, timestamp)
      return
    }
    if (record.status === 'received') {
      // 已落盘未执行：重新检查有效期与绑定后再分派。
      if (!record.text || this.isExpired(record.sentAt)) {
        this.deps.store.updateInbound(record.inboundId, { status: 'expired' }, timestamp)
        return
      }
      const binding = this.deps.store.findActiveBindingBySender(
        record.connectionId,
        record.senderId
      )
      if (!binding) {
        this.deps.store.updateInbound(record.inboundId, { status: 'ignored' }, timestamp)
        return
      }
      await this.dispatchBound(this.toMessage(record), record.inboundId, parseCommand(record.text))
      return
    }
    // status === 'executing'：先检查提交记录，再决定补建回复或收敛为失败。
    await this.recoverExecuting(record)
  }

  private async recoverExecuting(record: StoredChannelInbound): Promise<void> {
    const message = this.toMessage(record)
    const sessionId = record.sessionId
    if (!sessionId || !record.executionRef) {
      await this.persistAndDeliver(
        message,
        record.inboundId,
        sessionId,
        this.deps.replies.executionFailed(this.outputLanguage()),
        'failed'
      )
      return
    }
    const execution = await this.deps.conversationStore.findExecutionByUserMessage(
      sessionId,
      record.executionRef.userMessageId
    )
    if (execution) {
      if (execution.batch) {
        // 词库已提交：从已提交结果确定性补建待发回复，不重新执行收藏。
        const skill = this.deps.skills.get(execution.skillId)
        const text = skill
          ? skill.feedback(execution.batch, execution.explanationLanguage)
          : this.deps.replies.needsAttention(this.outputLanguage())
        await this.persistAndDeliver(message, record.inboundId, sessionId, text, 'succeeded')
        return
      }
      // 批次未落盘即无提交证据：不自动重跑，提示用户核对。
      await this.persistAndDeliver(
        message,
        record.inboundId,
        sessionId,
        this.deps.replies.needsAttention(this.outputLanguage()),
        'needs_attention'
      )
      return
    }
    // 会话消息路径：assistant 回复已持久化则补建，否则按失败收敛。
    const history = await this.deps.conversationStore.history(sessionId)
    const userIndex = history.findIndex((item) => item.id === record.executionRef!.userMessageId)
    const assistant =
      userIndex >= 0
        ? history.slice(userIndex + 1).find((item) => item.role === 'assistant')
        : undefined
    if (assistant) {
      await this.persistAndDeliver(
        message,
        record.inboundId,
        sessionId,
        assistant.content,
        'succeeded'
      )
      return
    }
    await this.persistAndDeliver(
      message,
      record.inboundId,
      sessionId,
      this.deps.replies.executionFailed(this.outputLanguage()),
      'failed'
    )
  }

  private toMessage(record: StoredChannelInbound): InboundChannelMessage {
    return {
      platform: record.platform,
      connectionId: record.connectionId,
      botId: record.botId,
      eventId: record.eventId,
      messageId: record.messageId,
      senderId: record.senderId,
      chatId: record.chatId,
      sentAt: record.sentAt,
      receivedAt: record.receivedAt,
      text: record.text ?? '',
      senderName: null
    }
  }

  // 重连或启动恢复后补发仍授权的待发回复；只重发已有结果，不重新执行。
  async deliverPendingReplies(): Promise<void> {
    const connection = this.deps.store.findSoleConnection()
    if (!connection) return
    if (this.drainingReplies) return
    this.drainingReplies = true
    try {
      for (const reply of this.deps.store.listPendingReplies(connection.connectionId)) {
        await this.attemptDelivery(reply)
      }
    } finally {
      this.drainingReplies = false
    }
  }

  dispose(): void {
    this.disposed = true
    this.pauseConnection()
  }
}

function isRequestNotFound(error: unknown): boolean {
  return error instanceof Error && error.name === 'RequestNotFoundError'
}
