import { z } from 'zod'
import {
  AdapterConnectionError,
  type AdapterContext,
  type CommunicationAdapter
} from '../../../core/communication/communication-adapter'
import type {
  EncodedPart,
  SendResult,
  Target
} from '../../../core/communication/communication-contract'
import {
  botIdentitySchema,
  telegramIdSchema,
  telegramUpdateIdSchema,
  mapUpdate,
  makeCursor,
  parseCursor
} from './telegram-protocol'
import { encodeTelegramText } from './telegram-encoding'
import { TelegramTransportError, type TelegramTransport } from './telegram-transport'
export interface TelegramClock {
  now(): number
  sleep(ms: number, signal: AbortSignal): Promise<void>
}
const defaultClock: TelegramClock = {
  now: Date.now,
  sleep(ms, signal) {
    return new Promise((resolve, reject) => {
      if (signal.aborted) {
        reject(new Error('CANCELLED'))
        return
      }
      const abort = (): void => {
        clearTimeout(timer)
        signal.removeEventListener('abort', abort)
        reject(new Error('CANCELLED'))
      }
      const timer = setTimeout(() => {
        signal.removeEventListener('abort', abort)
        resolve()
      }, ms)
      signal.addEventListener('abort', abort, { once: true })
    })
  }
}
function failure(error: unknown): { retryable: boolean; code: string; retryAfterMs?: number } {
  if (error instanceof TelegramTransportError)
    return {
      retryable: [
        'TELEGRAM_NETWORK',
        'TELEGRAM_RATE_LIMITED',
        'TELEGRAM_NOT_SENT',
        'TELEGRAM_ADMISSION_FAILED'
      ].includes(error.code),
      code: error.code,
      retryAfterMs: error.retryAfterMs
    }
  return { retryable: false, code: 'TELEGRAM_INVALID_RESPONSE' }
}
interface Generation {
  controller: AbortController
  signal: AbortSignal
  context: AdapterContext
  polling?: Promise<void>
}
export class TelegramAdapter implements CommunicationAdapter {
  readonly capabilities = {
    edit: false,
    interactions: false,
    attachments: false,
    maxTextLength: 4000,
    encodingVersion: 'telegram-plain-v1'
  }
  private active?: Generation
  private sends: Promise<void> = Promise.resolve()
  private connectionAt = 0
  private readonly chats = new Map<string, number>()
  constructor(
    private readonly transport: TelegramTransport,
    private readonly botId: string,
    private readonly clock: TelegramClock = defaultClock
  ) {}
  async start(context: AdapterContext): Promise<void> {
    if (this.active) throw new AdapterConnectionError(false)
    const controller = new AbortController()
    const generation: Generation = {
      controller,
      signal: AbortSignal.any([controller.signal, context.signal]),
      context
    }
    this.active = generation
    try {
      const identity = botIdentitySchema.parse(
        await this.transport.call('getMe', {}, generation.signal, 10000)
      )
      if (String(identity.id) !== this.botId)
        throw new AdapterConnectionError(false, 'TELEGRAM_BOT_MISMATCH')
      const webhook = z
        .object({ url: z.string().max(8192) })
        .parse(await this.transport.call('getWebhookInfo', {}, generation.signal, 10000))
      if (webhook.url) throw new AdapterConnectionError(false, 'TELEGRAM_WEBHOOK_CONFLICT')
      let offset: number | undefined
      try {
        offset = parseCursor(context.cursor, this.botId)
      } catch {
        throw new AdapterConnectionError(false, 'TELEGRAM_CURSOR_INVALID')
      }
      generation.signal.throwIfAborted()
      generation.polling = this.poll(generation, identity.username, offset)
    } catch (error) {
      if (error instanceof AdapterConnectionError) throw error
      const info = failure(error)
      throw new AdapterConnectionError(info.retryable, info.code, info.retryAfterMs)
    }
  }
  private async poll(g: Generation, username: string, offset?: number): Promise<void> {
    try {
      while (!g.signal.aborted) {
        const raw = await this.transport.call(
          'getUpdates',
          {
            ...(offset === undefined ? {} : { offset }),
            timeout: 20,
            limit: 20,
            allowed_updates: ['message']
          },
          g.signal,
          25000
        )
        g.signal.throwIfAborted()
        const updates = z
          .array(z.object({ update_id: telegramUpdateIdSchema }).passthrough())
          .max(20)
          .parse(raw)
          .sort((a, b) => a.update_id - b.update_id)
        for (const update of updates) {
          g.signal.throwIfAborted()
          const mapped = mapUpdate(update, username)
          const next = Math.max(offset ?? 1, mapped.updateId + 1)
          const cursor = makeCursor(this.botId, next)
          const receipt = mapped.event
            ? await g.context.receive(mapped.event, cursor)
            : await g.context.receiveRejected(mapped.rejected, cursor)
          if (receipt.status === 'failed')
            throw new TelegramTransportError('TELEGRAM_ADMISSION_FAILED', false)
          offset = next
        }
      }
    } catch (error) {
      if (!g.signal.aborted && this.active === g) {
        const info = failure(error)
        g.context.disconnected(info.retryable, info.code, info.retryAfterMs)
        g.controller.abort()
      }
    }
  }
  async stop(): Promise<void> {
    const active = this.active
    if (!active) return
    active.controller.abort()
    await Promise.all([active.polling, this.sends])
    if (this.active === active) this.active = undefined
  }
  encode(text: string): EncodedPart[] {
    return encodeTelegramText(text)
  }
  send(
    target: Target,
    part: EncodedPart,
    _identity: { deliveryId: string; partId: string },
    signal: AbortSignal
  ): Promise<SendResult> {
    const deadline = this.clock.now() + 29500
    const active = this.active
    const work = this.sends.then(() => this.sendOnce(active, target, part, signal, deadline))
    this.sends = work.then(
      () => {},
      () => {}
    )
    return work
  }
  private async sendOnce(
    active: Generation | undefined,
    target: Target,
    part: EncodedPart,
    signal: AbortSignal,
    deadline: number
  ): Promise<SendResult> {
    if (
      !active ||
      this.active !== active ||
      active.signal.aborted ||
      target.externalThreadId ||
      target.externalActorId !== target.externalConversationId ||
      !/^[1-9][0-9]*$/u.test(target.externalConversationId) ||
      !Number.isSafeInteger(Number(target.externalConversationId)) ||
      part.format !== 'plain' ||
      part.payload !== undefined ||
      !part.text.length ||
      part.text.length > 4000
    )
      return { status: 'failed' }
    const combined = AbortSignal.any([signal, active.signal])
    try {
      const now = this.clock.now()
      const wait = Math.max(
        0,
        this.connectionAt - now,
        (this.chats.get(target.externalConversationId) ?? 0) - now
      )
      if (now + wait >= deadline) return { status: 'retry', retryAfterMs: wait }
      if (wait) await this.clock.sleep(wait, combined)
      combined.throwIfAborted()
      const remaining = deadline - this.clock.now()
      if (remaining <= 0) return { status: 'retry' }
      this.connectionAt = this.clock.now() + 40
      for (const [chat, until] of this.chats) if (until <= this.clock.now()) this.chats.delete(chat)
      this.chats.set(target.externalConversationId, this.clock.now() + 1000)
      let result: unknown
      try {
        result = await this.transport.call(
          'sendMessage',
          {
            chat_id: target.externalConversationId,
            text: part.text,
            link_preview_options: { is_disabled: true }
          },
          combined,
          remaining
        )
      } catch (error) {
        if (error instanceof TelegramTransportError) {
          if (!error.started) return { status: 'retry' }
          if (error.status === 429) {
            // Flood control can apply to the whole bot, including other queued deliveries.
            this.connectionAt = Math.max(
              this.connectionAt,
              this.clock.now() + (error.retryAfterMs ?? 0)
            )
            return { status: 'retry', retryAfterMs: error.retryAfterMs }
          }
          if (error.status && error.status >= 400 && error.status < 500) {
            if (error.status === 401) {
              active.context.disconnected(false, 'TELEGRAM_UNAUTHORIZED')
              active.controller.abort()
            }
            return { status: 'failed' }
          }
        }
        return { status: 'uncertain' }
      }
      const message = z
        .object({
          message_id: telegramIdSchema,
          chat: z.object({ id: telegramIdSchema, type: z.literal('private') })
        })
        .safeParse(result)
      return message.success && String(message.data.chat.id) === target.externalConversationId
        ? { status: 'sent', externalMessageId: String(message.data.message_id) }
        : { status: 'uncertain' }
    } catch {
      return { status: 'retry' }
    } // Waiting was cancelled before a request was initiated.
  }
}
