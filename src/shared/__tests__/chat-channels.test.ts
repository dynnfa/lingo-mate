import { describe, expect, it } from 'vitest'
import {
  CHAT_CHANNELS_IPC,
  chatChannelsEventSchema,
  chatChannelsStatusResultSchema,
  configureChatChannelConnectionInputSchema
} from '../chat-channels'

const VALID_UUID = 'f9364f0f-f3f4-4ea6-a31d-b55754aa2477'
const ISO_TIMESTAMP = '2026-09-23T08:00:00.000Z'

describe('CHAT_CHANNELS_IPC', () => {
  it('uses stable domain channel names', () => {
    expect(CHAT_CHANNELS_IPC).toEqual({
      getStatus: 'chatChannels:getStatus',
      configureConnection: 'chatChannels:configureConnection',
      connect: 'chatChannels:connect',
      disconnect: 'chatChannels:disconnect',
      issueBindingCode: 'chatChannels:issueBindingCode',
      confirmBinding: 'chatChannels:confirmBinding',
      rejectBinding: 'chatChannels:rejectBinding',
      unbind: 'chatChannels:unbind',
      event: 'chatChannels:event'
    })
  })
})

describe('configureChatChannelConnectionInputSchema', () => {
  it('trims the token and rejects blank or oversized values', () => {
    expect(configureChatChannelConnectionInputSchema.parse({ token: ' 123:ABC ' })).toEqual({
      token: '123:ABC'
    })
    expect(configureChatChannelConnectionInputSchema.safeParse({ token: '   ' }).success).toBe(
      false
    )
    expect(
      configureChatChannelConnectionInputSchema.safeParse({ token: 'x'.repeat(257) }).success
    ).toBe(false)
  })
})

describe('chatChannelsStatusResultSchema', () => {
  it('accepts a status without any configured connection', () => {
    const result = chatChannelsStatusResultSchema.parse({
      status: 'ok',
      connection: null,
      binding: null,
      pendingBindingRequest: null
    })
    expect(result.status).toBe('ok')
  })

  it('accepts a disconnected connection with an active binding and no pending request', () => {
    const result = chatChannelsStatusResultSchema.parse({
      status: 'ok',
      connection: {
        connectionId: VALID_UUID,
        platform: 'telegram',
        botId: '6000000001',
        botUsername: 'lingo_mate_bot',
        state: 'disconnected',
        createdAt: ISO_TIMESTAMP,
        updatedAt: ISO_TIMESTAMP
      },
      binding: {
        bindingId: VALID_UUID,
        connectionId: VALID_UUID,
        platform: 'telegram',
        senderId: '7000000001',
        displayName: 'Leon',
        boundAt: ISO_TIMESTAMP
      },
      pendingBindingRequest: null
    })
    expect(result.status).toBe('ok')
  })

  it('accepts a pending binding request waiting for desktop confirmation', () => {
    const result = chatChannelsStatusResultSchema.parse({
      status: 'ok',
      connection: {
        connectionId: VALID_UUID,
        platform: 'telegram',
        botId: '6000000001',
        botUsername: null,
        state: 'error',
        errorCode: 'WEBHOOK_CONFLICT',
        createdAt: ISO_TIMESTAMP,
        updatedAt: ISO_TIMESTAMP
      },
      binding: null,
      pendingBindingRequest: {
        bindingId: VALID_UUID,
        connectionId: VALID_UUID,
        platform: 'telegram',
        senderId: '7000000001',
        displayName: 'Leon',
        requestedAt: ISO_TIMESTAMP
      }
    })
    expect(result.status).toBe('ok')
  })

  it('rejects an unknown platform', () => {
    expect(
      chatChannelsStatusResultSchema.safeParse({
        status: 'ok',
        connection: {
          connectionId: VALID_UUID,
          platform: 'discord',
          botId: '6000000001',
          botUsername: null,
          createdAt: ISO_TIMESTAMP,
          updatedAt: ISO_TIMESTAMP
        },
        binding: null,
        pendingBindingRequest: null
      }).success
    ).toBe(false)
  })

  it('accepts the error branch with a known error code', () => {
    expect(
      chatChannelsStatusResultSchema.parse({
        status: 'error',
        error: { code: 'CHANNELS_READ_FAILED' }
      }).status
    ).toBe('error')
  })
})

describe('chatChannelsEventSchema', () => {
  it('accepts connection state changes with an optional error code', () => {
    expect(
      chatChannelsEventSchema.parse({
        type: 'connectionStateChanged',
        connectionId: VALID_UUID,
        state: 'connected'
      })
    ).toEqual({
      type: 'connectionStateChanged',
      connectionId: VALID_UUID,
      state: 'connected'
    })
    expect(
      chatChannelsEventSchema.parse({
        type: 'connectionStateChanged',
        connectionId: VALID_UUID,
        state: 'error',
        errorCode: 'WEBHOOK_CONFLICT'
      })
    ).toMatchObject({ errorCode: 'WEBHOOK_CONFLICT' })
  })

  it('rejects unknown event types and unknown states', () => {
    expect(
      chatChannelsEventSchema.safeParse({
        type: 'messageArrived',
        connectionId: VALID_UUID
      }).success
    ).toBe(false)
    expect(
      chatChannelsEventSchema.safeParse({
        type: 'connectionStateChanged',
        connectionId: VALID_UUID,
        state: 'polling'
      }).success
    ).toBe(false)
  })
})
