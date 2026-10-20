import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ChannelError } from '../../core/channels/channel-errors'
import { CHAT_CHANNELS_IPC } from '../../shared/chat-channels'
import { ChatChannelsService, type ChatChannelsServiceDeps } from '../chat-channels-service'
import { registerChatChannelsIpc } from '../chat-channels-ipc'
import { createTrustedHandlerRegistrar } from '../ipc-guard'
import { FakeSender, registeredHandler, RENDERER_URL, resetIpcMocks } from './helpers/ipc-test-env'

vi.mock('electron', async () => (await import('./helpers/ipc-test-env')).electronTestModule())

beforeEach(resetIpcMocks)

describe('chat channel binding rejection IPC', () => {
  it.each(['NO_PENDING_BINDING_REQUEST', 'UNKNOWN_ERROR'] as const)(
    'returns %s instead of acknowledging a failed rejection',
    async (code) => {
      const service = new ChatChannelsService({
        module: {
          rejectPendingBinding: () => {
            if (code === 'NO_PENDING_BINDING_REQUEST') throw new ChannelError(code)
            throw new Error('storage unavailable')
          }
        }
      } as unknown as ChatChannelsServiceDeps)
      registerChatChannelsIpc(service, createTrustedHandlerRegistrar({ rendererUrl: RENDERER_URL }))
      expect(
        await registeredHandler(CHAT_CHANNELS_IPC.rejectBinding)(
          { sender: new FakeSender() },
          undefined
        )
      ).toEqual({ status: 'error', error: { code } })
    }
  )
})
