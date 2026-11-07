import type { AdapterContext } from '../../src/core/communication/communication-adapter'
import type { InboundEvent, Receipt } from '../../src/core/communication/communication-contract'
import { QqAdapter } from '../../src/main/channels/qq/qq-adapter'
import type { QqSocketFactory, QqSocketHandlers } from '../../src/main/channels/qq/qq-gateway'

type PassiveReply = { content: string; msg_id: string; msg_seq: number }
type LoginFrame = { op: 2 | 6; d: { token: string; session_id?: string; seq?: number } }

export function qqHarness(): {
  adapter: QqAdapter
  sentTexts(): string[]
  sent: PassiveReply[]
  loginFrames: LoginFrame[]
  disconnect(code: number): void
  inject(event: InboundEvent, index?: string): Promise<Receipt>
} {
  const sent: PassiveReply[] = []
  const loginFrames: LoginFrame[] = []
  const pending: Array<(receipt: Receipt) => void> = []
  let handlers: QqSocketHandlers | undefined
  let sequence = 0
  let gatewaySession = 0
  let tokenRequests = 0
  const open: QqSocketFactory = (_url, callbacks) => {
    handlers = callbacks
    queueMicrotask(() =>
      callbacks.message(JSON.stringify({ op: 10, d: { heartbeat_interval: 45000 } }))
    )
    return {
      send: (raw) => {
        const frame = JSON.parse(raw) as LoginFrame | { op: 1 }
        const { op } = frame
        if (op === 2 || op === 6) loginFrames.push(frame)
        if (op === 1) callbacks.message(JSON.stringify({ op: 11 }))
        if (op === 2) {
          gatewaySession++
          callbacks.message(
            JSON.stringify({
              op: 0,
              t: 'READY',
              s: ++sequence,
              d: { session_id: 'session-' + gatewaySession }
            })
          )
        }
        if (op === 6) callbacks.message(JSON.stringify({ op: 0, t: 'RESUMED', s: ++sequence }))
      },
      close: () => {
        if (handlers === callbacks) handlers = undefined
      }
    }
  }
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input))
    if (url.pathname === '/app/getAppAccessToken')
      return Response.json({
        access_token: 'PRIVATE_QQ_ACCESS_TOKEN_' + ++tokenRequests,
        expires_in: '7200'
      })
    if (url.pathname === '/gateway/bot')
      return Response.json({ url: 'wss://api.bot.qq.com/websocket' })
    if (!/^\/v2\/users\/(PRIVATE_EXTERNAL_ACTOR|actor)\/messages$/u.test(url.pathname))
      return Response.json({}, { status: 404 })
    sent.push(JSON.parse(String(init?.body)))
    return Response.json({ id: 'qq-sent-' + sent.length })
  }
  class ObservedAdapter extends QqAdapter {
    override start(context: AdapterContext): Promise<void> {
      return super.start({
        ...context,
        receive: async (event, cursor) => {
          const receipt = await context.receive(event, cursor)
          pending.shift()?.(receipt)
          return receipt
        }
      })
    }
  }
  const adapter = new ObservedAdapter('123456', 'PRIVATE_QQ_APP_SECRET', { open, fetch: fetcher })
  return {
    adapter,
    sentTexts: () => sent.map((part) => part.content),
    sent,
    loginFrames,
    disconnect: (code) => handlers!.ended(code),
    inject(event: InboundEvent, index = 'REFIDX_fixture=='): Promise<Receipt> {
      if (!handlers || event.type !== 'text')
        return Promise.resolve({ status: 'failed', code: 'STOPPED' })
      return new Promise((resolve) => {
        pending.push(resolve)
        handlers!.message(
          JSON.stringify({
            op: 0,
            t: 'C2C_MESSAGE_CREATE',
            s: ++sequence,
            id: 'event-' + sequence,
            d: {
              id: event.externalMessageId,
              author: { user_openid: event.externalActorId },
              content: event.text,
              timestamp: new Date(event.occurredAt).toISOString(),
              message_type: 0,
              message_scene: { ext: ['msg_idx=' + index, 'auth_token=PRIVATE_QQ_SCENE_TOKEN'] }
            }
          })
        )
      })
    }
  }
}
