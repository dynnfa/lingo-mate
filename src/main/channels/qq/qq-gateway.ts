import WebSocket from 'ws'
import {
  AdapterConnectionError,
  type AdapterContext
} from '../../../core/communication/communication-adapter'
import type { Receipt } from '../../../core/communication/communication-contract'
import {
  dispatchMetadata,
  firstInvalidField,
  gatewayFrame,
  hello,
  mapDispatch,
  parseJson,
  ready,
  QQ_C2C_INTENT,
  QQ_MAX_FRAME_BYTES,
  type GatewayFrame,
  type QqCursor
} from './qq-protocol'

export interface QqSocketHandlers {
  message(text: string | undefined): void
  ended(code?: number): void
}

export type QqSocketFactory = (
  url: string,
  handlers: QqSocketHandlers
) => { send(frame: string): void; close(): void }

export const openQqSocket: QqSocketFactory = (url, handlers) => {
  const socket = new WebSocket(url, {
    followRedirects: false,
    handshakeTimeout: 10_000,
    maxPayload: QQ_MAX_FRAME_BYTES,
    perMessageDeflate: false
  })
  socket.on('message', (data, binary) => {
    handlers.message(!binary && Buffer.isBuffer(data) ? data.toString('utf8') : undefined)
  })
  socket.on('close', (code) => handlers.ended(code))
  socket.on('error', () => {
    // ws emits close after transport errors. Keep the close classification.
  })
  socket.on('unexpected-response', (_request, response) => {
    const status = response.statusCode
    handlers.ended(status === 429 ? 4008 : status === 401 || status === 403 ? 4014 : undefined)
    response.destroy()
  })
  return { send: (text) => socket.send(text), close: () => socket.terminate() }
}

const MAX_QUEUED_FRAMES = 32
const gatewayError = (): AdapterConnectionError =>
  new AdapterConnectionError(false, 'QQ_GATEWAY_UNAVAILABLE')
const lost = (): AdapterConnectionError => new AdapterConnectionError(true, 'CONNECTION_LOST')
const admissionFailed = (): AdapterConnectionError =>
  new AdapterConnectionError(true, 'QQ_ADMISSION_FAILED')

const RECEIPT_DIAGNOSTIC_INTERVAL_MS = 5_000
const knownReceiptCodes = new Set([
  'AWAITING_CONFIRMATION',
  'CHALLENGE_INVALID',
  'BACKPRESSURE',
  'STORAGE_FAILED',
  'INVALID_INPUT',
  'STOPPED',
  'UNSUPPORTED_INPUT',
  'UNSUPPORTED_SCOPE',
  'EXPIRED',
  'RATE_LIMITED',
  'UNBOUND',
  'EVENT_CONFLICT',
  'CAPABILITY_DENIED',
  'CONFIRMATION_INVALID',
  'BUSY',
  'QUEUE_FULL'
])

function receiptMetadata(receipt: Receipt): {
  receiptStatus: Receipt['status']
  receiptCode?: string
} {
  const { status, code } = receipt
  return {
    receiptStatus: status,
    receiptCode: code === undefined || knownReceiptCodes.has(code) ? code : 'unknown'
  }
}

type GatewayPhase = 'hello' | 'identify' | 'resume' | 'online'
type DiagnosticDetails = Partial<ReturnType<typeof dispatchMetadata>> & {
  reason?: string
  validationField?: string
  receiptStatus?: Receipt['status']
  receiptCode?: string
  firstReplaySequence?: number
  closeCode?: number
  errorCode?: AdapterConnectionError['code']
}
export type QqGatewayDiagnostic = DiagnosticDetails & {
  code:
    'QQ_ADMISSION_FAILED' | 'QQ_GATEWAY_RECEIPT' | 'QQ_GATEWAY_RESUME' | 'QQ_GATEWAY_DISCONNECTED'
  phase: GatewayPhase
  durableSequence?: number
}

export class QqGateway {
  private socket?: ReturnType<QqSocketFactory>
  private heartbeat?: ReturnType<typeof setInterval>
  private awaitingAck = false
  private closed = false
  private phase: GatewayPhase = 'hello'
  private latest: number | null = null
  private durable?: number
  private firstReplaySequence?: number
  private readonly lastReceiptDiagnostic = new Map<string, number>()
  private sessionId?: string
  private processing = false
  private readonly queue: GatewayFrame[] = []
  private readonly login: Promise<void>
  private resolveLogin!: () => void
  private rejectLogin!: (reason: AdapterConnectionError) => void
  private readonly abort = (): void => this.finish()

  constructor(
    private readonly context: AdapterContext,
    private readonly controller: AbortController,
    private readonly appId: string,
    private readonly authorization: string,
    private readonly open: QqSocketFactory,
    private readonly resume?: QqCursor,
    private readonly onDiagnostic?: (entry: QqGatewayDiagnostic) => void
  ) {
    this.login = new Promise((resolve, reject) => {
      this.resolveLogin = resolve
      this.rejectLogin = reject
    })
  }

  start(url: string): Promise<void> {
    if (this.controller.signal.aborted) this.finish()
    else {
      this.controller.signal.addEventListener('abort', this.abort, { once: true })
      try {
        this.socket = this.open(url, {
          message: (text) => this.receive(text),
          ended: (code) => this.socketEnded(code)
        })
      } catch {
        this.finish(lost())
      }
    }
    return this.login
  }

  get online(): boolean {
    return !this.closed && this.phase === 'online'
  }

  private receive(text: string | undefined): void {
    if (this.closed) return
    const parsed = gatewayFrame.safeParse(
      text && Buffer.byteLength(text) <= QQ_MAX_FRAME_BYTES ? parseJson(text) : undefined
    )
    if (!parsed.success) {
      this.finish(lost(), {
        reason: 'invalid-frame',
        validationField: firstInvalidField(parsed.error, gatewayFrame)
      })
      return
    }
    const frame = parsed.data
    switch (frame.op) {
      case 10:
        this.identify(frame.d)
        break
      case 1:
        this.beat()
        break
      case 11:
        this.awaitingAck = false
        break
      case 7:
        this.finish(lost(), { reason: 'reconnect-requested' })
        break
      case 9:
        if (this.phase !== 'resume') this.finish(gatewayError())
        else if (frame.d === true)
          this.finish(new AdapterConnectionError(true, 'CONNECTION_LOST', 3000), {
            reason: 'resume-retry'
          })
        else this.invalidateSession()
        break
      case 0:
        if (frame.s === undefined) return this.failAdmission('missing-sequence', frame)
        if (!frame.t) return this.failAdmission('missing-event-type', frame)
        if (this.phase === 'hello') return this.failAdmission('dispatch-before-hello', frame)
        if (this.queue.length >= MAX_QUEUED_FRAMES)
          return this.failAdmission('gateway-queue-full', frame)
        this.latest = Math.max(this.latest ?? 0, frame.s)
        this.queue.push(frame)
        if (!this.processing) void this.drain()
        break
    }
  }

  private identify(payload: unknown): void {
    const parsed = hello.safeParse(payload)
    if (this.phase !== 'hello' || !parsed.success) {
      this.finish(gatewayError())
      return
    }
    if (this.resume) {
      this.phase = 'resume'
      this.latest = this.durable = this.resume.seq
      this.sessionId = this.resume.sessionId
      this.report('QQ_GATEWAY_RESUME', { reason: 'requested' })
      this.write({
        op: 6,
        d: { token: this.authorization, session_id: this.sessionId, seq: this.durable }
      })
    } else {
      this.phase = 'identify'
      this.write({ op: 2, d: { token: this.authorization, intents: QQ_C2C_INTENT, shard: [0, 1] } })
    }
    if (!this.closed) {
      this.heartbeat = setInterval(() => {
        if (this.awaitingAck) this.finish(lost(), { reason: 'heartbeat-timeout' })
        else this.beat()
      }, parsed.data.heartbeat_interval)
      this.heartbeat.unref()
    }
  }

  private beat(): void {
    this.awaitingAck = true
    this.write({ op: 1, d: this.latest })
  }

  private write(frame: { op: number; d: unknown }): void {
    try {
      this.socket!.send(JSON.stringify(frame))
    } catch {
      this.finish(lost())
    }
  }

  private async drain(): Promise<void> {
    this.processing = true
    let frame: GatewayFrame | undefined
    try {
      while (!this.closed && this.queue.length) {
        frame = this.queue.shift()!
        if (frame.t === 'READY' || frame.t === 'RESUMED') {
          this.ready(frame)
          continue
        }
        if (!this.sessionId || (this.phase !== 'resume' && !this.online)) {
          this.finish(gatewayError())
          break
        }
        const seq = frame.s!
        if (this.durable !== undefined && seq <= this.durable) continue
        const cursor = this.serializeCursor(this.sessionId, seq)
        const admission = mapDispatch(frame, cursor)
        const receipt =
          'event' in admission
            ? await this.context.receive(admission.event, cursor)
            : await this.context.receiveRejected(admission.rejected, cursor)
        const validationField = 'rejected' in admission ? admission.validationField : undefined
        if (!admissionHasIdentity(admission)) {
          this.failAdmission('missing-event-identity', frame, receipt, validationField)
          break
        }
        if (receipt.status !== 'persisted' && receipt.status !== 'rejected') {
          this.failAdmission('receipt-failed', frame, receipt, validationField)
          break
        }
        this.durable = seq
        if (this.phase === 'resume') this.firstReplaySequence ??= seq
        this.reportReceipt(frame, receipt, validationField)
      }
    } catch {
      this.failAdmission('dispatch-exception', frame)
    } finally {
      this.processing = false
    }
  }

  private ready(frame: GatewayFrame): void {
    if (frame.t === 'READY' && this.phase === 'identify') {
      const parsed = ready.safeParse(frame.d)
      if (!parsed.success) {
        this.finish(gatewayError())
        return
      }
      const sessionId = parsed.data.session_id
      const seq = frame.s!
      if (!this.context.saveInitialCursor?.(this.serializeCursor(sessionId, seq))) {
        this.failAdmission('initial-cursor-not-saved', frame)
        return
      }
      this.sessionId = sessionId
      this.durable = seq
    } else if (frame.t !== 'RESUMED' || this.phase !== 'resume') {
      this.finish(gatewayError())
      return
    } else {
      this.report('QQ_GATEWAY_RESUME', {
        reason: 'completed',
        sequence: frame.s,
        firstReplaySequence: this.firstReplaySequence
      })
    }
    this.phase = 'online'
    this.resolveLogin()
  }

  private serializeCursor(sessionId: string, seq: number): string {
    return JSON.stringify({ version: 1, appId: this.appId, sessionId, seq } satisfies QqCursor)
  }

  private invalidateSession(closeCode?: number): void {
    try {
      if (!this.context.discardCursor?.()) throw admissionFailed()
      this.finish(new AdapterConnectionError(true, 'CONNECTION_LOST', 3000), {
        reason: 'session-invalidated',
        closeCode
      })
    } catch {
      this.failAdmission('cursor-not-discarded')
    }
  }

  private socketEnded(code?: number): void {
    if (this.closed) return
    const details = { reason: 'socket-closed', closeCode: code }
    if (code === 4008)
      this.finish(new AdapterConnectionError(true, 'QQ_RATE_LIMITED', 60_000), details)
    else if (code === 4004) {
      // The next connection attempt creates its own token cache.
      this.finish(new AdapterConnectionError(true, 'QQ_UNAUTHORIZED'), details)
    } else if ([1008, 4013, 4014, 4914, 4915].includes(code ?? 0))
      this.finish(gatewayError(), details)
    else if (
      code === 4006 ||
      code === 4007 ||
      code === 4009 ||
      (code !== undefined && code >= 4900 && code <= 4913)
    )
      this.invalidateSession(code)
    else this.finish(lost(), details)
  }

  private failAdmission(
    reason: string,
    frame?: GatewayFrame,
    receipt?: Receipt,
    validationField?: string
  ): void {
    if (this.closed) return
    this.report('QQ_ADMISSION_FAILED', {
      reason,
      ...(frame && dispatchMetadata(frame, validationField)),
      ...(receipt && receiptMetadata(receipt)),
      validationField
    })
    this.finish(admissionFailed())
  }

  private reportReceipt(frame: GatewayFrame, receipt: Receipt, validationField?: string): void {
    if (this.closed || !this.onDiagnostic || frame.t !== 'C2C_MESSAGE_CREATE') return
    const details = receiptMetadata(receipt)
    // Bound routine traffic independently of binding results and validation failures.
    const key = JSON.stringify([details.receiptStatus, details.receiptCode, validationField])
    const now = performance.now()
    const last = this.lastReceiptDiagnostic.get(key)
    if (last !== undefined && now - last < RECEIPT_DIAGNOSTIC_INTERVAL_MS) return
    this.lastReceiptDiagnostic.set(key, now)
    this.report('QQ_GATEWAY_RECEIPT', {
      ...dispatchMetadata(frame, validationField),
      ...details,
      validationField
    })
  }

  private report(code: QqGatewayDiagnostic['code'], details: DiagnosticDetails): void {
    try {
      this.onDiagnostic?.({ code, phase: this.phase, durableSequence: this.durable, ...details })
    } catch {
      // Diagnostics cannot alter gateway processing.
    }
  }

  private finish(error?: AdapterConnectionError, details?: DiagnosticDetails): void {
    if (this.closed) return
    const wasOnline = this.online
    this.closed = true
    if (error && error.code !== 'QQ_ADMISSION_FAILED') {
      // errorCode keeps the connection classification; details.reason names the specific cause.
      this.report('QQ_GATEWAY_DISCONNECTED', { errorCode: error.code, ...details })
    }
    this.queue.length = 0
    clearInterval(this.heartbeat)
    this.controller.signal.removeEventListener('abort', this.abort)
    this.controller.abort()
    this.socket?.close()
    this.socket = undefined
    if (!wasOnline) this.rejectLogin(error ?? lost())
    else if (error) this.context.disconnected(error.retryable, error.code, error.retryAfterMs)
  }
}

function admissionHasIdentity(admission: ReturnType<typeof mapDispatch>): boolean {
  return 'event' in admission || admission.rejected !== undefined
}
