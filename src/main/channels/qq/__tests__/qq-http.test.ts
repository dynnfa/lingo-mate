import { afterEach, expect, it, vi } from 'vitest'
import { QqHttp } from '../qq-http'

afterEach(() => vi.restoreAllMocks())

it('shares concurrent refreshes, honors expires_in and reuses the refreshed authorization', async () => {
  const now = vi.spyOn(Date, 'now').mockReturnValue(1000)
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json({ access_token: 'first', expires_in: '100' }))
    .mockResolvedValueOnce(Response.json({ access_token: 'second', expires_in: 100 }))
  const client = new QqHttp('123456', 'fixture-secret', new AbortController().signal, fetcher)
  expect(await Promise.all([client.authorization(), client.authorization()])).toEqual([
    'QQBot first',
    'QQBot first'
  ])
  now.mockReturnValue(81_000)
  expect(
    await Promise.all([client.authorization(), client.authorization(), client.authorization()])
  ).toEqual(['QQBot second', 'QQBot second', 'QQBot second'])
  expect(fetcher).toHaveBeenCalledTimes(2)
  expect(fetcher).toHaveBeenCalledWith(
    'https://api.bot.qq.com/app/getAppAccessToken',
    expect.objectContaining({
      redirect: 'error',
      method: 'POST',
      body: JSON.stringify({ appId: '123456', clientSecret: 'fixture-secret' })
    })
  )
})

it.each([
  'wss://api.bot.qq.com.evil.invalid/websocket',
  'wss://api.bot.qq.com:8443/websocket',
  'wss://api.bot.qq.com/websocket?target=outside',
  'wss://api.bot.qq.com/elsewhere',
  'ws://api.bot.qq.com/websocket',
  'wss://user@api.bot.qq.com/websocket'
])('rejects a gateway outside the allowlist (%s)', async (url) => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ url }))
  const client = new QqHttp('123456', 'fixture-secret', new AbortController().signal, fetcher)
  await expect(client.gateway('QQBot fixture')).rejects.toMatchObject({
    code: 'QQ_INVALID_RESPONSE'
  })
})

it('classifies HTTP 200 credential business failures without disclosing the response', async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValue(Response.json({ code: 100016, message: 'PRIVATE' }))
  const client = new QqHttp('123456', 'fixture-secret', new AbortController().signal, fetcher)
  await expect(client.authorization()).rejects.toMatchObject({
    retryable: false,
    code: 'QQ_UNAUTHORIZED'
  })
})

it('keeps a send with an unreadable receipt uncertain and performs no hidden retry', async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json({ access_token: 'fixture-token', expires_in: 7200 }))
    .mockRejectedValueOnce(new Error('socket lost'))
  const controller = new AbortController()
  const client = new QqHttp('123456', 'fixture-secret', controller.signal, fetcher)
  expect(
    await client.send(
      'OPENID',
      {
        content: 'hello',
        msg_type: 0,
        msg_id: 'message',
        msg_seq: 1
      },
      Date.now() + 60_000,
      controller.signal
    )
  ).toEqual({ status: 'uncertain' })
  expect(fetcher).toHaveBeenCalledTimes(2)
})

it('lets an existing session resume when the quota for creating new sessions is exhausted', async () => {
  const url = 'wss://api.bot.qq.com/websocket'
  const fetcher = vi.fn<typeof fetch>(async () =>
    Response.json({ url, session_start_limit: { remaining: 0, reset_after: 10000 } })
  )
  const client = new QqHttp('123456', 'fixture-secret', new AbortController().signal, fetcher)
  await expect(client.gateway('QQBot fixture')).rejects.toMatchObject({
    code: 'QQ_RATE_LIMITED',
    retryAfterMs: 10000
  })
  await expect(client.gateway('QQBot fixture', true)).resolves.toBe(url)
})
