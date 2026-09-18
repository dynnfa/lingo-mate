import { beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import {
  createTrustedHandlerRegistrar,
  noInputSchema,
  type TrustedHandlerConfig,
  type TrustedHandlerContext
} from '../ipc-guard'
import {
  electronMocks,
  FakeSender,
  type IpcHandler,
  registeredHandler,
  RENDERER_URL,
  resetIpcMocks
} from './helpers/ipc-test-env'

vi.mock('electron', async () => (await import('./helpers/ipc-test-env')).electronTestModule())

const CHANNEL = 'guard:probe'

const inputSchema = z.strictObject({ name: z.string().min(1) })
const resultSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('ok'), value: z.string() }),
  z.object({
    status: z.literal('error'),
    error: z.object({
      code: z.enum(['UNTRUSTED_SOURCE', 'INVALID_INPUT', 'INVALID_NAME', 'BUSY', 'UNKNOWN_ERROR']),
      field: z.literal('name').optional()
    })
  })
])

type ProbeResult = z.output<typeof resultSchema>
type ProbeConfig = TrustedHandlerConfig<typeof inputSchema, typeof resultSchema>
type ProbeHandler = (
  input: z.output<typeof inputSchema>,
  context: TrustedHandlerContext
) => ProbeResult | Promise<ProbeResult>

function registerProbe(handler: ProbeHandler): void {
  const register = createTrustedHandlerRegistrar({ rendererUrl: RENDERER_URL })
  register({
    channel: CHANNEL,
    inputSchema,
    resultSchema,
    invalidInputError: () => ({ code: 'INVALID_INPUT' }),
    mapError: () => ({ code: 'UNKNOWN_ERROR' }),
    fallbackError: { code: 'UNKNOWN_ERROR' },
    handler
  } satisfies ProbeConfig)
}

beforeEach(resetIpcMocks)

describe('trusted handler registrar', () => {
  it('requires a usable trusted renderer url', () => {
    expect(() => createTrustedHandlerRegistrar({ rendererUrl: '' })).toThrow()
    expect(() => createTrustedHandlerRegistrar({ rendererUrl: 'not a url' })).toThrow()
    expect(() => createTrustedHandlerRegistrar({ rendererUrl: RENDERER_URL })).not.toThrow()
  })

  it('rejects untrusted sources before calling the handler', async () => {
    const handler = vi.fn<ProbeHandler>(() => ({ status: 'ok', value: 'unused' }))
    registerProbe(handler)

    const foreign = new FakeSender()
    foreign.owned = false
    const navigated = new FakeSender()
    navigated.mainFrame = { url: 'https://untrusted.invalid/' }
    const destroyed = new FakeSender()
    destroyed.destroyed = true
    const sender = new FakeSender()

    const untrusted = { status: 'error', error: { code: 'UNTRUSTED_SOURCE' } }
    expect(registeredHandler(CHANNEL)({ sender: foreign }, { name: 'a' })).toEqual(untrusted)
    expect(registeredHandler(CHANNEL)({ sender: navigated }, { name: 'a' })).toEqual(untrusted)
    expect(registeredHandler(CHANNEL)({ sender: destroyed }, { name: 'a' })).toEqual(untrusted)
    expect(registeredHandler(CHANNEL)({ sender, senderFrame: null }, { name: 'a' })).toEqual(
      untrusted
    )
    // 子 frame：senderFrame 存在且 URL 匹配，但不是 sender 的主 frame。
    expect(
      registeredHandler(CHANNEL)({ sender, senderFrame: { url: RENDERER_URL } }, { name: 'a' })
    ).toEqual(untrusted)
    expect(handler).not.toHaveBeenCalled()
  })

  it('validates input before calling the handler and keeps field-level errors', () => {
    const handler = vi.fn<ProbeHandler>(() => ({ status: 'ok', value: 'unused' }))
    const register = createTrustedHandlerRegistrar({ rendererUrl: RENDERER_URL })
    register({
      channel: CHANNEL,
      inputSchema,
      resultSchema,
      invalidInputError: (issues) =>
        issues.some((issue) => issue.path.includes('name'))
          ? { code: 'INVALID_NAME', field: 'name' }
          : { code: 'INVALID_INPUT' },
      mapError: () => ({ code: 'UNKNOWN_ERROR' }),
      fallbackError: { code: 'UNKNOWN_ERROR' },
      handler
    } satisfies ProbeConfig)

    expect(registeredHandler(CHANNEL)({ sender: new FakeSender() }, { name: '' })).toEqual({
      status: 'error',
      error: { code: 'INVALID_NAME', field: 'name' }
    })
    expect(registeredHandler(CHANNEL)({ sender: new FakeSender() }, 'name')).toEqual({
      status: 'error',
      error: { code: 'INVALID_INPUT' }
    })
    expect(handler).not.toHaveBeenCalled()
  })

  it('invokes the handler with the parsed input and sender context', async () => {
    const handler = vi.fn<ProbeHandler>((input, context) => {
      expect(input).toEqual({ name: 'apple' })
      expect(context.sender).toBeInstanceOf(FakeSender)
      return { status: 'ok', value: input.name }
    })
    registerProbe(handler)

    const sender = new FakeSender()
    expect(registeredHandler(CHANNEL)({ sender }, { name: 'apple' })).toEqual({
      status: 'ok',
      value: 'apple'
    })
  })

  it('maps synchronous throws and async rejections to safe errors', async () => {
    const handler = vi
      .fn<ProbeHandler>()
      .mockImplementationOnce(() => {
        throw new Error('SELECT * FROM secrets; stack /Users/x/secret.sqlite')
      })
      .mockImplementationOnce(() => Promise.reject(new Error('apiKey=sk-secret')))
    registerProbe(handler)

    const syncResult = registeredHandler(CHANNEL)({ sender: new FakeSender() }, { name: 'a' })
    expect(syncResult).toEqual({ status: 'error', error: { code: 'UNKNOWN_ERROR' } })
    expect(JSON.stringify(syncResult)).not.toContain('secret')
    expect(JSON.stringify(syncResult)).not.toContain('SELECT')

    await expect(
      registeredHandler(CHANNEL)({ sender: new FakeSender() }, { name: 'a' })
    ).resolves.toEqual({ status: 'error', error: { code: 'UNKNOWN_ERROR' } })
  })

  it('falls back when the error mapping itself throws or breaks the protocol', async () => {
    const handler = vi.fn<ProbeHandler>(() => {
      throw new Error('boom')
    })
    const register = createTrustedHandlerRegistrar({ rendererUrl: RENDERER_URL })
    register({
      channel: CHANNEL,
      inputSchema,
      resultSchema,
      invalidInputError: () => ({ code: 'INVALID_INPUT' }),
      mapError: () => {
        throw new Error('mapping blew up')
      },
      fallbackError: { code: 'BUSY' },
      handler
    } satisfies ProbeConfig)

    expect(registeredHandler(CHANNEL)({ sender: new FakeSender() }, { name: 'a' })).toEqual({
      status: 'error',
      error: { code: 'BUSY' }
    })

    register({
      channel: 'guard:bad-mapping',
      inputSchema,
      resultSchema,
      invalidInputError: () => ({ code: 'INVALID_INPUT' }),
      mapError: () => ({ code: 'NOT_A_PROTOCOL_CODE' }) as never,
      fallbackError: { code: 'BUSY' },
      handler
    } satisfies ProbeConfig)
    const badMappingRegistration = electronMocks.handle.mock.calls.find(
      ([channel]) => channel === 'guard:bad-mapping'
    )
    const badMappingSender = new FakeSender()
    expect(
      (badMappingRegistration?.[1] as IpcHandler)(
        { sender: badMappingSender, senderFrame: badMappingSender.mainFrame },
        { name: 'a' }
      )
    ).toEqual({ status: 'error', error: { code: 'BUSY' } })
  })

  it('replaces malformed handler results with the fixed fallback', () => {
    const handler = vi
      .fn<ProbeHandler>()
      .mockReturnValueOnce({ status: 'ok', value: 'fine' })
      .mockReturnValueOnce({ status: 'ok', value: 42 } as never)
      .mockReturnValueOnce({ status: 'error', error: { code: 'NOT_A_PROTOCOL_CODE' } } as never)
    const register = createTrustedHandlerRegistrar({ rendererUrl: RENDERER_URL })
    register({
      channel: CHANNEL,
      inputSchema,
      resultSchema,
      invalidInputError: () => ({ code: 'INVALID_INPUT' }),
      mapError: () => ({ code: 'UNKNOWN_ERROR' }),
      fallbackError: { code: 'UNKNOWN_ERROR' },
      handler
    } satisfies ProbeConfig)

    const handler0 = registeredHandler(CHANNEL)
    expect(handler0({ sender: new FakeSender() }, { name: 'a' })).toEqual({
      status: 'ok',
      value: 'fine'
    })
    expect(handler0({ sender: new FakeSender() }, { name: 'a' })).toEqual({
      status: 'error',
      error: { code: 'UNKNOWN_ERROR' }
    })
    expect(handler0({ sender: new FakeSender() }, { name: 'a' })).toEqual({
      status: 'error',
      error: { code: 'UNKNOWN_ERROR' }
    })
  })

  it('enforces an explicit input contract for no-argument channels', () => {
    const handler = vi.fn<(input: undefined, context: TrustedHandlerContext) => ProbeResult>(
      () => ({ status: 'ok', value: 'unused' })
    )
    const register = createTrustedHandlerRegistrar({ rendererUrl: RENDERER_URL })
    register({
      channel: CHANNEL,
      inputSchema: noInputSchema,
      resultSchema,
      invalidInputError: () => ({ code: 'INVALID_INPUT' }),
      mapError: () => ({ code: 'UNKNOWN_ERROR' }),
      fallbackError: { code: 'UNKNOWN_ERROR' },
      handler
    } satisfies TrustedHandlerConfig<typeof noInputSchema, typeof resultSchema>)

    expect(registeredHandler(CHANNEL)({ sender: new FakeSender() }, undefined)).toEqual({
      status: 'ok',
      value: 'unused'
    })
    expect(registeredHandler(CHANNEL)({ sender: new FakeSender() }, { name: 'a' })).toEqual({
      status: 'error',
      error: { code: 'INVALID_INPUT' }
    })
    expect(handler).toHaveBeenCalledTimes(1)
  })

  it('blocks registration when fixed results violate the protocol', () => {
    const narrowResultSchema = z.discriminatedUnion('status', [
      z.object({ status: z.literal('ok'), value: z.string() }),
      z.object({
        status: z.literal('error'),
        error: z.object({ code: z.literal('INVALID_INPUT') })
      })
    ])
    const register = createTrustedHandlerRegistrar({ rendererUrl: RENDERER_URL })

    expect(() =>
      register({
        channel: CHANNEL,
        inputSchema,
        resultSchema: narrowResultSchema,
        invalidInputError: () => ({ code: 'INVALID_INPUT' }),
        mapError: () => ({ code: 'INVALID_INPUT' }),
        fallbackError: { code: 'INVALID_INPUT' },
        handler: () => ({ status: 'ok', value: 'unused' })
      } satisfies TrustedHandlerConfig<typeof inputSchema, typeof narrowResultSchema>)
    ).toThrow(/UNTRUSTED_SOURCE|协议/)

    expect(() =>
      register({
        channel: CHANNEL,
        inputSchema,
        resultSchema,
        invalidInputError: () => ({ code: 'INVALID_INPUT' }),
        mapError: () => ({ code: 'UNKNOWN_ERROR' }),
        fallbackError: { code: 'NOT_A_PROTOCOL_CODE' } as never,
        handler: () => ({ status: 'ok', value: 'unused' })
      } satisfies ProbeConfig)
    ).toThrow(/协议/)
    expect(electronMocks.handle).not.toHaveBeenCalled()
  })

  it('unregisters the handler through the returned cleanup', () => {
    const register = createTrustedHandlerRegistrar({ rendererUrl: RENDERER_URL })
    const cleanup = register({
      channel: CHANNEL,
      inputSchema,
      resultSchema,
      invalidInputError: () => ({ code: 'INVALID_INPUT' }),
      mapError: () => ({ code: 'UNKNOWN_ERROR' }),
      fallbackError: { code: 'UNKNOWN_ERROR' },
      handler: () => ({ status: 'ok', value: 'unused' })
    } satisfies ProbeConfig)

    expect(electronMocks.removeHandler).not.toHaveBeenCalled()
    cleanup()
    expect(electronMocks.removeHandler).toHaveBeenCalledWith(CHANNEL)
  })
})

describe('ipc guard diagnostics', () => {
  function registerWithDiagnostics(
    diagnostics: { report: (entry: unknown) => void },
    config: Partial<ProbeConfig> & Pick<ProbeConfig, 'handler'>
  ): void {
    const register = createTrustedHandlerRegistrar(
      { rendererUrl: RENDERER_URL },
      diagnostics as never
    )
    register({
      channel: CHANNEL,
      inputSchema,
      resultSchema,
      invalidInputError: () => ({ code: 'INVALID_INPUT' }),
      mapError: () => ({ code: 'UNKNOWN_ERROR' }),
      fallbackError: { code: 'UNKNOWN_ERROR' },
      ...config
    } as ProbeConfig)
  }

  it('logs handler throws and async rejections with the original error', async () => {
    const report = vi.fn()
    const origin = new Error('origin boom before mapping')
    registerWithDiagnostics(
      { report },
      {
        handler: vi
          .fn<ProbeHandler>()
          .mockImplementationOnce(() => {
            throw origin
          })
          .mockImplementationOnce(() => Promise.reject(origin))
      }
    )

    registeredHandler(CHANNEL)({ sender: new FakeSender() }, { name: 'a' })
    await registeredHandler(CHANNEL)({ sender: new FakeSender() }, { name: 'a' })

    expect(report).toHaveBeenCalledTimes(2)
    for (const [entry] of report.mock.calls as Array<[Record<string, unknown>]>) {
      expect(entry['level']).toBe('error')
      expect(entry['operation']).toBe('handler')
      expect(entry['error']).toBe(origin)
      expect(entry['context']).toEqual({ channel: CHANNEL })
    }
  })

  it('logs invalid input as warn with safe issue metadata only', () => {
    const report = vi.fn()
    registerWithDiagnostics({ report }, { handler: () => ({ status: 'ok', value: 'unused' }) })

    registeredHandler(CHANNEL)(
      { sender: new FakeSender() },
      { name: 'a', secret: 'user-typed-secret' }
    )

    expect(report).toHaveBeenCalledTimes(1)
    const [entry] = report.mock.calls[0] as [Record<string, unknown>]
    expect(entry['level']).toBe('warn')
    expect(entry['operation']).toBe('invalid-input')
    expect(entry['context']).toEqual({
      channel: CHANNEL,
      issues: [{ path: [], code: 'unrecognized_keys' }]
    })
    // 只保留 issue 的 path 与 code，不携带输入值或完整 message。
    expect(JSON.stringify(entry)).not.toContain('user-typed-secret')
  })

  it('logs untrusted source rejections as warn with channel metadata only', () => {
    const report = vi.fn()
    registerWithDiagnostics({ report }, { handler: () => ({ status: 'ok', value: 'unused' }) })

    const foreign = new FakeSender()
    foreign.owned = false
    registeredHandler(CHANNEL)({ sender: foreign }, { name: 'a' })

    expect(report).toHaveBeenCalledTimes(1)
    const [entry] = report.mock.calls[0] as [Record<string, unknown>]
    expect(entry['level']).toBe('warn')
    expect(entry['operation']).toBe('untrusted-source')
    expect(entry['context']).toEqual({ channel: CHANNEL })
  })

  it('logs mapping failures when mapError throws or breaks the protocol', () => {
    const report = vi.fn()
    registerWithDiagnostics(
      { report },
      {
        handler: () => {
          throw new Error('handler boom')
        },
        mapError: () => {
          throw new Error('mapping blew up')
        }
      }
    )

    expect(registeredHandler(CHANNEL)({ sender: new FakeSender() }, { name: 'a' })).toEqual({
      status: 'error',
      error: { code: 'UNKNOWN_ERROR' }
    })

    const operations = (report.mock.calls as Array<[Record<string, unknown>]>).map(
      ([entry]) => entry['operation']
    )
    expect(operations).toEqual(['handler', 'map-error'])
  })

  it('logs result validation failures and still returns the fallback', () => {
    const report = vi.fn()
    registerWithDiagnostics(
      { report },
      {
        handler: () => ({ status: 'ok', value: 42 }) as never
      }
    )

    expect(registeredHandler(CHANNEL)({ sender: new FakeSender() }, { name: 'a' })).toEqual({
      status: 'error',
      error: { code: 'UNKNOWN_ERROR' }
    })

    const [entry] = report.mock.calls[0] as [Record<string, unknown>]
    expect(entry['level']).toBe('error')
    expect(entry['operation']).toBe('result-validation')
    expect(entry['context']).toMatchObject({ channel: CHANNEL })
  })

  it('keeps guard behavior when diagnostics reporting itself throws', () => {
    const report = vi.fn(() => {
      throw new Error('diagnostics channel broken')
    })
    registerWithDiagnostics(
      { report },
      {
        handler: () => {
          throw new Error('handler boom')
        }
      }
    )

    expect(registeredHandler(CHANNEL)({ sender: new FakeSender() }, { name: 'a' })).toEqual({
      status: 'error',
      error: { code: 'UNKNOWN_ERROR' }
    })
  })
})
