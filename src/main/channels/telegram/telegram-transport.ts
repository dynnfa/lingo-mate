import { z } from 'zod'
import { telegramTokenSchema, TELEGRAM_RESPONSE_BYTES } from './telegram-protocol'
const methods = ['getMe', 'getWebhookInfo', 'getUpdates', 'sendMessage'] as const
export type TelegramMethod = (typeof methods)[number]
export interface TelegramTransport {
  call(
    method: TelegramMethod,
    parameters: Readonly<Record<string, unknown>>,
    signal: AbortSignal,
    deadlineMs: number
  ): Promise<unknown>
}
// Never retain vendor descriptions, URLs, Request objects or exception causes.
export class TelegramTransportError extends Error {
  constructor(
    readonly code: string,
    readonly started: boolean,
    readonly status?: number,
    readonly retryAfterMs?: number
  ) {
    super(code)
  }
}
const envelopeSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), result: z.unknown() }),
  z.object({
    ok: z.literal(false),
    error_code: z.number().int().min(400).max(599),
    parameters: z
      .object({
        retry_after: z
          .number()
          .int()
          .positive()
          .max(Math.floor(Number.MAX_SAFE_INTEGER / 1000))
          .optional()
      })
      .optional()
  })
])
export function createTelegramTransport(
  token: string,
  fetcher: typeof fetch = globalThis.fetch
): TelegramTransport {
  telegramTokenSchema.parse(token)
  return {
    async call(method, parameters, signal, deadlineMs) {
      if (!methods.includes(method) || signal.aborted || deadlineMs <= 0)
        throw new TelegramTransportError('TELEGRAM_NOT_SENT', false)
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), deadlineMs)
      let started = false
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
      try {
        started = true
        const response = await fetcher(`https://api.telegram.org/bot${token}/${method}`, {
          method: 'POST',
          redirect: 'error',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(parameters),
          signal: AbortSignal.any([signal, controller.signal])
        })
        if (!response.body) throw new TelegramTransportError('TELEGRAM_INVALID_RESPONSE', true)
        reader = response.body.getReader()
        const chunks: Uint8Array[] = []
        let bytes = 0
        while (true) {
          const chunk = await reader.read()
          if (chunk.done) break
          bytes += chunk.value.byteLength
          if (bytes > TELEGRAM_RESPONSE_BYTES)
            throw new TelegramTransportError('TELEGRAM_RESPONSE_TOO_LARGE', true)
          chunks.push(chunk.value)
        }
        if (response.status >= 500)
          throw new TelegramTransportError('TELEGRAM_NETWORK', true, response.status)
        let result: z.infer<typeof envelopeSchema>
        try {
          const body = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))
          result = envelopeSchema.parse(JSON.parse(body))
        } catch {
          throw new TelegramTransportError('TELEGRAM_INVALID_RESPONSE', true)
        }
        if (!result.ok) {
          if (result.error_code !== response.status || response.status >= 500)
            throw new TelegramTransportError('TELEGRAM_INVALID_RESPONSE', true)
          const code =
            result.error_code === 401
              ? 'TELEGRAM_UNAUTHORIZED'
              : result.error_code === 409
                ? 'TELEGRAM_POLL_CONFLICT'
                : result.error_code === 429
                  ? 'TELEGRAM_RATE_LIMITED'
                  : 'TELEGRAM_REJECTED'
          throw new TelegramTransportError(
            code,
            true,
            result.error_code,
            result.parameters?.retry_after === undefined
              ? undefined
              : result.parameters.retry_after * 1000
          )
        }
        if (!response.ok) throw new TelegramTransportError('TELEGRAM_INVALID_RESPONSE', true)
        return result.result
      } catch (error) {
        if (error instanceof TelegramTransportError) throw error
        throw new TelegramTransportError('TELEGRAM_NETWORK', started)
      } finally {
        clearTimeout(timer)
        controller.abort()
        await reader?.cancel().catch(() => {})
      }
    }
  }
}
