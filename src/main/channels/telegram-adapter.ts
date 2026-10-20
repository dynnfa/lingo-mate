import type {
  ChannelDeliveryOutcome,
  ChannelOutboundTarget,
  ChannelTransport,
  InboundChannelMessage,
  IgnoredChannelEvent
} from '../../core/channels/channel-types'
import type {
  ChatChannelConnectionErrorCode,
  ChatChannelConnectionState
} from '../../shared/chat-channels'
import { TelegramApiError, type TelegramApiClient, type TelegramUpdate } from './telegram-api'
import { z } from 'zod'

// Telegram long polling 适配器：接收、校验、发送与游标推进。
// - 只接受普通私聊文本消息；群聊、频道、编辑消息等事件安全推进游标且不保存正文。
// - 同一 Bot 只允许一个轮询实例：409 冲突（webhook 或其他消费者）时停止并上报。
// - 出站文本按 Telegram 4096 上限在行边界分段；平台不承诺 exactly-once 投递。

export interface TelegramAdapterHandlers {
  onMessage(message: InboundChannelMessage): void | Promise<void>
  onIgnored(event: IgnoredChannelEvent): void | Promise<void>
  commitCursor?(offset: number): void | Promise<void>
  onStateChanged?(
    state: ChatChannelConnectionState,
    errorCode?: ChatChannelConnectionErrorCode
  ): void
}

export interface TelegramAdapterOptions {
  pollTimeoutSeconds?: number
  pollIntervalMs?: number
  backoffBaseMs?: number
  backoffMaxMs?: number
  now?: () => Date
  sleep?: (ms: number) => Promise<void>
}

const TELEGRAM_MESSAGE_LIMIT = 4096

export class TelegramChannelAdapter implements ChannelTransport {
  private readonly pollTimeoutSeconds: number
  private readonly pollIntervalMs: number
  private readonly backoffBaseMs: number
  private readonly backoffMaxMs: number
  private readonly now: () => Date
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>
  private controller: AbortController | null = null
  private starting = false
  private polling = false
  private recoveringFromNetworkError = false

  constructor(
    private readonly api: TelegramApiClient,
    private readonly connectionId: string,
    private readonly botId: string,
    private readonly handlers: TelegramAdapterHandlers,
    options: TelegramAdapterOptions = {}
  ) {
    this.pollTimeoutSeconds = options.pollTimeoutSeconds ?? 25
    this.pollIntervalMs = options.pollIntervalMs ?? 250
    this.backoffBaseMs = options.backoffBaseMs ?? 1_000
    this.backoffMaxMs = options.backoffMaxMs ?? 60_000
    this.now = options.now ?? (() => new Date())
    this.sleep =
      options.sleep ??
      ((ms, signal) =>
        new Promise<void>((resolve) => {
          if (signal?.aborted) {
            resolve()
            return
          }
          const finish = (): void => {
            clearTimeout(timer)
            signal?.removeEventListener('abort', finish)
            resolve()
          }
          const timer = setTimeout(finish, ms)
          signal?.addEventListener('abort', finish, { once: true })
        }))
  }

  isPolling(): boolean {
    return this.polling
  }

  isStarting(): boolean {
    return this.starting
  }

  // 首次检查等待结果；临时网络错误在后台退避，设置页仍可断开连接。
  async start(offset: number): Promise<void> {
    if (this.polling || this.starting) return
    this.starting = true
    const controller = new AbortController()
    this.controller = controller
    this.handlers.onStateChanged?.('connecting')
    if (!(await this.tryStartPolling(offset, controller))) {
      void this.retryStartup(offset, controller)
    }
  }

  private async retryStartup(offset: number, controller: AbortController): Promise<void> {
    let backoffMs = this.backoffBaseMs
    while (this.controller === controller && !controller.signal.aborted) {
      await this.sleep(backoffMs, controller.signal)
      if (this.controller !== controller || controller.signal.aborted) return
      if (await this.tryStartPolling(offset, controller)) return
      backoffMs = Math.min(backoffMs * 2, this.backoffMaxMs)
    }
  }

  // true 表示已连接、已停止或遇到不可重试错误；false 表示需退避重试。
  private async tryStartPolling(offset: number, controller: AbortController): Promise<boolean> {
    try {
      const webhook = await this.api.getWebhookInfo(controller.signal)
      if (this.controller !== controller || controller.signal.aborted) return true
      if (webhook.url) {
        this.starting = false
        this.handlers.onStateChanged?.('error', 'WEBHOOK_CONFLICT')
        return true
      }
    } catch (error) {
      if (this.controller !== controller || controller.signal.aborted) return true
      const retryable =
        error instanceof TelegramApiError &&
        (error.code === 'NETWORK' || (error.httpStatus ?? 0) >= 500)
      this.starting = retryable
      this.reportStateError(error)
      return !retryable
    }
    this.starting = false
    this.polling = true
    this.recoveringFromNetworkError = false
    this.handlers.onStateChanged?.('connected')
    void this.pollLoop(offset, controller).finally(() => {
      if (this.controller === controller) this.polling = false
    })
    return true
  }

  stop(): void {
    this.starting = false
    this.controller?.abort()
    this.controller = null
    if (this.polling) {
      this.polling = false
      this.handlers.onStateChanged?.('disconnected')
    }
  }

  private async pollLoop(initialOffset: number, controller: AbortController): Promise<void> {
    let offset = initialOffset
    let backoffMs = this.backoffBaseMs
    while (this.polling && this.controller === controller && !controller.signal.aborted) {
      try {
        offset = await this.pollOnce(offset, controller.signal)
        if (this.controller !== controller || controller.signal.aborted) return
        if (this.recoveringFromNetworkError) {
          this.recoveringFromNetworkError = false
          this.handlers.onStateChanged?.('connected')
        }
        backoffMs = this.backoffBaseMs
        await this.sleep(this.pollIntervalMs, controller.signal)
      } catch (error) {
        if (!this.polling || this.controller !== controller || controller.signal.aborted) return
        if (error instanceof TelegramApiError && error.code === 'UNAUTHORIZED') {
          this.stop()
          this.reportStateError(error)
          return
        }
        if (
          error instanceof TelegramApiError &&
          (error.code === 'CONFLICT_WEBHOOK' || error.code === 'CONFLICT_POLLING')
        ) {
          this.stop()
          this.reportStateError(error)
          return
        }
        this.recoveringFromNetworkError = true
        this.reportStateError(error)
        await this.sleep(backoffMs, controller.signal)
        backoffMs = Math.min(backoffMs * 2, this.backoffMaxMs)
      }
    }
  }

  // 单次取批：按收到的顺序持久化处理结果后再推进游标并确认。
  async pollOnce(explicitOffset?: number, signal = this.controller?.signal): Promise<number> {
    const offset = explicitOffset ?? 0
    const updates = await this.api.getUpdates(offset, this.pollTimeoutSeconds, signal)
    if (signal?.aborted) return offset
    if (updates.length > 0) {
      await this.processBatch(updates, signal)
      if (signal?.aborted) return offset
      const next = updates[updates.length - 1].update_id + 1
      await this.handlers.commitCursor?.(next)
      return next
    }
    return offset
  }

  // 将一批原始更新转换为统一入站消息或忽略标记。
  async processBatch(updates: TelegramUpdate[], signal?: AbortSignal): Promise<void> {
    for (const update of updates) {
      if (signal?.aborted) return
      const message = normalizePrivateText(update)
      if (message) {
        await this.handlers.onMessage({
          platform: 'telegram',
          connectionId: this.connectionId,
          botId: this.botId,
          eventId: update.update_id,
          messageId: message.messageId,
          senderId: message.senderId,
          chatId: message.chatId,
          sentAt: message.sentAt,
          receivedAt: this.now().toISOString(),
          text: message.text,
          senderName: message.senderName
        })
      } else {
        await this.handlers.onIgnored({
          platform: 'telegram',
          connectionId: this.connectionId,
          botId: this.botId,
          eventId: update.update_id,
          reason: 'unsupported'
        })
      }
    }
  }

  // 出站发送：按平台长度限制在行边界分段后发送。
  async send(target: ChannelOutboundTarget, text: string): Promise<ChannelDeliveryOutcome> {
    try {
      for (const segment of splitForTelegram(text)) {
        await this.api.sendMessage(target.chatId, segment)
      }
      return { delivered: true }
    } catch (error) {
      if (error instanceof TelegramApiError && error.code === 'UNAUTHORIZED') throw error
      return { delivered: false }
    }
  }

  private reportStateError(error: unknown): void {
    const errorCode = toConnectionErrorCode(error)
    this.handlers.onStateChanged?.('error', errorCode)
  }
}

function toConnectionErrorCode(error: unknown): ChatChannelConnectionErrorCode {
  if (error instanceof TelegramApiError) {
    if (error.code === 'UNAUTHORIZED') return 'TOKEN_INVALID'
    if (error.code === 'CONFLICT_WEBHOOK') return 'WEBHOOK_CONFLICT'
    if (error.code === 'CONFLICT_POLLING') return 'DUPLICATE_POLLING'
    if (error.code === 'NETWORK') return 'NETWORK_ERROR'
  }
  return 'UNKNOWN_ERROR'
}

interface NormalizedMessage {
  messageId: number
  senderId: string
  chatId: string
  sentAt: string
  text: string
  senderName: string | null
}

const privateTextMessageSchema = z.object({
  message_id: z.number().int().safe(),
  from: z.object({
    id: z.number().int().safe(),
    is_bot: z.boolean().optional(),
    first_name: z.string().optional(),
    username: z.string().optional()
  }),
  chat: z.object({ id: z.number().int().safe(), type: z.string() }),
  date: z.number().int().nonnegative().safe(),
  text: z.string()
})

// 只接受普通私聊文本：编辑消息、群聊、频道、无文本、bot 发送者一律不支持。
function normalizePrivateText(update: TelegramUpdate): NormalizedMessage | null {
  const parsed = privateTextMessageSchema.safeParse(update.message)
  if (!parsed.success) return null
  const message = parsed.data
  if (message.chat.type !== 'private') return null
  if (message.from.is_bot) return null
  const text = message.text?.trim()
  if (!text) return null
  return {
    messageId: message.message_id,
    senderId: String(message.from.id),
    chatId: String(message.chat.id),
    sentAt: new Date(message.date * 1000).toISOString(),
    text,
    senderName: message.from.first_name ?? message.from.username ?? null
  }
}

// 在行边界分段，避免把单词切断；无行可用时按硬边界切。
export function splitForTelegram(text: string): string[] {
  if (text.length <= TELEGRAM_MESSAGE_LIMIT) return [text]
  const segments: string[] = []
  let remaining = text
  while (remaining.length > TELEGRAM_MESSAGE_LIMIT) {
    let cut = remaining.lastIndexOf('\n', TELEGRAM_MESSAGE_LIMIT - 1)
    if (cut < TELEGRAM_MESSAGE_LIMIT / 2) cut = TELEGRAM_MESSAGE_LIMIT
    else cut += 1 // 行边界分段保留换行，拼接后还原原文。
    segments.push(remaining.slice(0, cut))
    remaining = remaining.slice(cut)
  }
  if (remaining.length > 0) segments.push(remaining)
  return segments
}
