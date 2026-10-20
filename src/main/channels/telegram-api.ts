// Telegram Bot API 的极薄 HTTP 客户端：无 SDK 依赖，凭据只存在于 Main。
// 错误统一分类为安全错误码，原始响应不进入日志。
import { z } from 'zod'

export type TelegramApiErrorCode =
  'UNAUTHORIZED' | 'CONFLICT_WEBHOOK' | 'CONFLICT_POLLING' | 'NETWORK' | 'UNKNOWN'

export class TelegramApiError extends Error {
  constructor(
    readonly code: TelegramApiErrorCode,
    message: string,
    readonly httpStatus?: number
  ) {
    super(message)
    this.name = 'TelegramApiError'
  }
}

export interface TelegramBotIdentity {
  id: string
  username: string | null
}

export interface TelegramMessage {
  message_id: number
  from?: { id: number; is_bot?: boolean; first_name?: string; username?: string; title?: string }
  chat: { id: number; type: string; first_name?: string; title?: string }
  date: number
  text?: string
}

export interface TelegramUpdate {
  update_id: number
  message?: unknown
}

interface TelegramResponse {
  ok: boolean
  result?: unknown
  error_code?: number
  description?: string
}

const responseSchema = z.object({
  ok: z.boolean(),
  result: z.unknown().optional(),
  description: z.string().optional()
})
const botIdentitySchema = z.object({ id: z.number().int().safe(), username: z.string().optional() })
const updateSchema = z.object({
  update_id: z.number().int().nonnegative().safe(),
  message: z.unknown().optional()
})
const webhookSchema = z.object({ url: z.string().optional() })

const DEFAULT_BASE_URL = 'https://api.telegram.org'
const DEFAULT_TIMEOUT_MS = 90_000

export interface TelegramApiClientOptions {
  baseUrl?: string
  fetchImpl?: typeof fetch
  timeoutMs?: number
}

export class TelegramApiClient {
  private readonly baseUrl: string
  private readonly fetchImpl: typeof fetch
  private readonly timeoutMs: number

  constructor(
    private readonly token: string,
    options: TelegramApiClientOptions = {}
  ) {
    this.baseUrl = options.baseUrl ?? DEFAULT_BASE_URL
    this.fetchImpl = options.fetchImpl ?? fetch
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  }

  async getMe(signal?: AbortSignal): Promise<TelegramBotIdentity> {
    const result = botIdentitySchema.parse(await this.call('getMe', {}, signal))
    return { id: String(result.id), username: result.username ?? null }
  }

  async getUpdates(
    offset: number,
    timeoutSeconds: number,
    signal?: AbortSignal
  ): Promise<TelegramUpdate[]> {
    const result = await this.call(
      'getUpdates',
      { offset, timeout: timeoutSeconds, allowed_updates: ['message'] },
      signal,
      this.timeoutMs + 10_000 // long polling 等待平台侧响应上限
    )
    return z.array(updateSchema).parse(result)
  }

  async sendMessage(chatId: string, text: string, signal?: AbortSignal): Promise<void> {
    await this.call('sendMessage', { chat_id: chatId, text }, signal)
  }

  async getWebhookInfo(signal?: AbortSignal): Promise<{ url: string | null }> {
    const result = webhookSchema.parse(await this.call('getWebhookInfo', {}, signal))
    return { url: result.url || null }
  }

  private async call(
    method: string,
    body: Record<string, unknown>,
    signal: AbortSignal | undefined,
    timeoutMs = this.timeoutMs
  ): Promise<unknown> {
    // Token 只进入请求 URL；错误信息不回显完整 URL，避免凭据进入诊断。
    let response: Response
    try {
      response = await this.fetchImpl(`${this.baseUrl}/bot${this.token}/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
          : AbortSignal.timeout(timeoutMs)
      })
    } catch (error) {
      if (signal?.aborted) throw error
      throw new TelegramApiError('NETWORK', 'telegram request failed', undefined)
    }
    let payload: TelegramResponse
    try {
      payload = responseSchema.parse(await response.json())
    } catch {
      throw new TelegramApiError('UNKNOWN', 'telegram response was not json', response.status)
    }
    if (!response.ok || !payload.ok) {
      throw classifyApiError(response.status, payload.description ?? '')
    }
    return payload.result
  }
}

function classifyApiError(status: number, description: string): TelegramApiError {
  if (status === 401 || status === 403) {
    return new TelegramApiError('UNAUTHORIZED', 'telegram rejected the bot token', status)
  }
  if (status === 409) {
    if (/webhook/i.test(description)) {
      return new TelegramApiError('CONFLICT_WEBHOOK', 'a webhook is active for this bot', status)
    }
    return new TelegramApiError(
      'CONFLICT_POLLING',
      'another getUpdates consumer is running',
      status
    )
  }
  if (status === 429) {
    return new TelegramApiError('NETWORK', 'telegram rate limited the request', status)
  }
  return new TelegramApiError('UNKNOWN', 'telegram api error', status)
}
