import type { AdapterContext } from '../../src/core/communication/communication-adapter'
import type { InboundEvent, Receipt } from '../../src/core/communication/communication-contract'
import { TelegramAdapter } from '../../src/main/channels/telegram/telegram-adapter'
import type { TelegramTransport } from '../../src/main/channels/telegram/telegram-transport'
// Controlled Bot API server. Every injected update passes through TelegramAdapter's
// polling, raw mapping and the real public receiver before its receipt resolves.
export function telegramHarness(): {
  adapter: TelegramAdapter
  inject(event: InboundEvent, cursor?: string): Promise<Receipt>
  sentTexts(): string[]
  injectRaw(raw: unknown): Promise<Receipt>
} {
  const sent: string[] = []
  const batches: unknown[][] = []
  const pending = new Map<string, (receipt: Receipt) => void>()
  const ids = new Map<string, number>()
  let next = 1
  let wake: (() => void) | undefined
  let active = false
  let time = Date.now()
  const transport: TelegramTransport = {
    async call(method, parameters, signal) {
      if (method === 'getMe') return { id: 123456, is_bot: true, username: 'lingo_bot' }
      if (method === 'getWebhookInfo') return { url: '' }
      if (method === 'sendMessage') {
        sent.push(String(parameters.text))
        return { message_id: sent.length, chat: { id: 5, type: 'private' } }
      }
      if (!batches.length)
        await new Promise<void>((resolve, reject) => {
          const abort = (): void => {
            wake = undefined
            reject(new Error('cancelled'))
          }
          if (signal.aborted) {
            abort()
            return
          }
          signal.addEventListener('abort', abort, { once: true })
          wake = () => {
            signal.removeEventListener('abort', abort)
            wake = undefined
            resolve()
          }
        })
      return batches.shift() ?? []
    }
  }
  class ObservedAdapter extends TelegramAdapter {
    override async start(context: AdapterContext): Promise<void> {
      active = true
      const observe = (id: string, receipt: Receipt): Receipt => {
        pending.get(id)?.(receipt)
        pending.delete(id)
        return receipt
      }
      await super.start({
        ...context,
        receive: async (event, cursor) =>
          observe((event as InboundEvent).externalEventId, await context.receive(event, cursor)),
        receiveRejected: async (envelope, cursor) => {
          const receipt = await context.receiveRejected(envelope, cursor)
          return envelope ? observe(envelope.externalEventId, receipt) : receipt
        }
      })
    }
    override async stop(): Promise<void> {
      active = false
      await super.stop()
    }
  }
  const adapter = new ObservedAdapter(transport, '123456', {
    now: () => time,
    sleep: async (ms) => {
      time += ms
    }
  })
  const injectRaw = (raw: unknown): Promise<Receipt> => {
    if (!active) return Promise.resolve({ status: 'failed', code: 'STOPPED' })
    const id = String((raw as { update_id: number }).update_id)
    return new Promise((resolve) => {
      pending.set(id, resolve)
      batches.push([raw])
      wake?.()
    })
  }
  return {
    adapter,
    sentTexts: () => [...sent],
    injectRaw,
    inject(event) {
      let id = ids.get(event.externalEventId)
      if (id === undefined) {
        id = next++
        ids.set(event.externalEventId, id)
      }
      return injectRaw({
        update_id: id,
        message: {
          message_id: id,
          date: Math.floor(event.occurredAt / 1000),
          from: { id: 5, is_bot: false },
          chat: { id: 5, type: event.scope === 'private' ? 'private' : 'group' },
          ...(event.type === 'text' ? { text: event.text } : {})
        }
      })
    }
  }
}
