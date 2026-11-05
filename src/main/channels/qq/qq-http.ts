import { z } from 'zod'
import { AdapterConnectionError } from '../../../core/communication/communication-adapter'
import type { SendResult } from '../../../core/communication/communication-contract'
import { parseJson, qqMessageId } from './qq-protocol'

const QQ_API = 'https://api.bot.qq.com'
const MAX_RESPONSE = 32 * 1024
const HTTP_TIMEOUT = 10_000
const tokenSchema = z.object({
  access_token: z.string().regex(/^[A-Za-z0-9_.+/=~-]{1,4096}$/u),
  expires_in: z
    .union([
      z.number(),
      z
        .string()
        .regex(/^\d{1,6}$/u)
        .transform(Number)
    ])
    .pipe(z.number().int().positive().max(86_400))
})
const businessCode = z.union([
  z.number().int(),
  z
    .string()
    .regex(/^\d{1,10}$/u)
    .transform(Number)
])
const responseCode = z.object({ code: businessCode.optional(), err_code: businessCode.optional() })
const gateway = z.object({
  url: z.string().regex(/^wss:\/\/api\.(?:bot|sgroup)\.qq\.com(?::443)?\/websocket\/?$/u),
  session_start_limit: z
    .object({
      remaining: z.number().int().nonnegative(),
      reset_after: z.number().int().nonnegative().max(86_400_000)
    })
    .optional()
})
const sentMessage = z.object({ id: qqMessageId })

type QqResponse = {
  status: number
  retryAfterMs?: number
  body: unknown
  code?: number
  codeValid: boolean
}
type PassiveMessage = { content: string; msg_type: 0; msg_id: string; msg_seq: number }

export class QqHttp {
  private token?: { value: string; refreshAt: number }
  private refreshing?: Promise<string>

  constructor(
    private readonly appId: string,
    private readonly secret: string,
    private readonly lifetime: AbortSignal,
    private readonly fetcher: typeof fetch = fetch
  ) {}

  authorization(): Promise<string> {
    this.lifetime.throwIfAborted()
    if (this.token && this.token.refreshAt > Date.now()) return Promise.resolve(this.token.value)
    this.refreshing ??= this.refresh().finally(() => {
      this.refreshing = undefined
    })
    return this.refreshing
  }

  private async refresh(): Promise<string> {
    const result = await this.managementRequest('/app/getAppAccessToken', {
      method: 'POST',
      body: JSON.stringify({ appId: this.appId, clientSecret: this.secret })
    })
    const token = tokenSchema.safeParse(result.body)
    if (!token.success) throw new AdapterConnectionError(false, 'QQ_INVALID_RESPONSE')
    const ttl = token.data.expires_in * 1000
    const value = 'QQBot ' + token.data.access_token
    this.token = { value, refreshAt: Date.now() + ttl - Math.min(60_000, ttl / 5) }
    return value
  }

  async gateway(authorization: string, resuming = false): Promise<string> {
    const result = await this.managementRequest('/gateway/bot', {
      headers: { Authorization: authorization }
    })
    const parsed = gateway.safeParse(result.body)
    if (!parsed.success) throw new AdapterConnectionError(false, 'QQ_INVALID_RESPONSE')
    const limit = parsed.data.session_start_limit
    if (!resuming && limit?.remaining === 0)
      throw new AdapterConnectionError(true, 'QQ_RATE_LIMITED', limit.reset_after)
    return parsed.data.url
  }

  private async managementRequest(path: string, init: RequestInit): Promise<QqResponse> {
    let response: QqResponse
    try {
      response = await this.request(path, init, this.lifetime)
    } catch {
      throw new AdapterConnectionError(true, 'QQ_NETWORK')
    }
    const { status, code, retryAfterMs } = response
    if (status === 429 || code === 100001)
      throw new AdapterConnectionError(true, 'QQ_RATE_LIMITED', retryAfterMs)
    if (status === 401 || [10004, 100007, 100016].includes(code ?? 0))
      throw new AdapterConnectionError(false, 'QQ_UNAUTHORIZED')
    if (status >= 500) throw new AdapterConnectionError(true, 'QQ_NETWORK')
    if (status < 200 || status >= 300 || (code !== undefined && code !== 0))
      throw new AdapterConnectionError(false, 'QQ_GATEWAY_UNAVAILABLE')
    if (!response.codeValid) throw new AdapterConnectionError(false, 'QQ_INVALID_RESPONSE')
    return response
  }

  async send(
    openId: string,
    message: PassiveMessage,
    expiresAt: number,
    signal: AbortSignal
  ): Promise<SendResult> {
    let authorization: string
    try {
      authorization = await this.authorization()
    } catch (error) {
      if (signal.aborted || this.lifetime.aborted) return { status: 'retry' }
      return error instanceof AdapterConnectionError && error.retryable
        ? { status: 'retry', retryAfterMs: error.retryAfterMs }
        : { status: 'failed', terminal: true }
    }
    if (signal.aborted || this.lifetime.aborted) return { status: 'retry' }
    if (expiresAt <= Date.now()) return { status: 'failed', terminal: true }
    let response: QqResponse
    try {
      response = await this.request(
        '/v2/users/' + encodeURIComponent(openId) + '/messages',
        {
          method: 'POST',
          headers: { Authorization: authorization },
          body: JSON.stringify(message)
        },
        signal
      )
    } catch {
      return { status: 'uncertain' }
    }
    const { status, code, retryAfterMs } = response
    if (code === 40054005) return { status: 'uncertain' }
    if (status === 429 || code === 100001) return { status: 'retry', retryAfterMs }
    if (status === 401) {
      // The platform explicitly refused this request. The next attempt refreshes.
      if (this.token?.value === authorization) this.token = undefined
      return { status: 'retry' }
    }
    if (status === 408 || status >= 500) return { status: 'uncertain' }
    if (status >= 400 || (code !== undefined && code !== 0))
      return { status: 'failed', terminal: true }
    const sent = sentMessage.safeParse(response.body)
    return status >= 200 && status < 300 && response.codeValid && sent.success
      ? { status: 'sent', externalMessageId: sent.data.id }
      : { status: 'uncertain' }
  }

  private async request(path: string, init: RequestInit, signal: AbortSignal): Promise<QqResponse> {
    const response = await this.fetcher(QQ_API + path, {
      ...init,
      headers: { ...init.headers, ...(init.body ? { 'Content-Type': 'application/json' } : {}) },
      redirect: 'error',
      signal: AbortSignal.any([this.lifetime, signal, AbortSignal.timeout(HTTP_TIMEOUT)])
    })
    const body = await readJson(response).catch(() => undefined)
    const parsed = responseCode.safeParse(body)
    const code = parsed.data?.code
    const retryAfter = response.headers.get('retry-after')
    return {
      status: response.status,
      body,
      code: code ? code : (parsed.data?.err_code ?? code),
      codeValid: parsed.success,
      retryAfterMs: retryAfter === null ? undefined : parseRetryAfter(retryAfter)
    }
  }
}

function parseRetryAfter(value: string): number | undefined {
  const ms = /^\d{1,10}$/u.test(value) ? Number(value) * 1000 : Date.parse(value) - Date.now()
  return Number.isFinite(ms) ? Math.max(0, ms) : undefined
}

async function readJson(response: Response): Promise<unknown> {
  const reader = response.body?.getReader()
  if (!reader) return undefined
  try {
    const decoder = new TextDecoder('utf-8', { fatal: true })
    let text = '',
      size = 0
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) return parseJson(text + decoder.decode())
      size += chunk.value.byteLength
      if (size > MAX_RESPONSE) return undefined
      text += decoder.decode(chunk.value, { stream: true })
    }
  } finally {
    void reader.cancel().catch(() => {})
  }
}
