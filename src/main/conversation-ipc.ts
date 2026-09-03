import type { WebContents } from 'electron'
import { ipcMain } from 'electron'
import type { ConversationModule } from '../core/conversation/conversation-module'
import {
  cancelMessageInputSchema,
  CONVERSATION_CHANNELS,
  conversationEventSchema,
  loadConversationInputSchema,
  sendMessageInputSchema,
  type CreateConversationResult,
  type ListConversationsResult,
  type LoadConversationResult,
  type SendMessageResult
} from '../shared/conversation'
import { toSafeIpcError, toSafeRequestError } from './conversation-errors'

export function registerConversationIpc(module: ConversationModule): void {
  ipcMain.handle(CONVERSATION_CHANNELS.create, async (): Promise<CreateConversationResult> => {
    try {
      return { status: 'ok', conversation: await module.createConversation() }
    } catch (error) {
      return { status: 'error', error: toSafeRequestError(error) }
    }
  })

  ipcMain.handle(CONVERSATION_CHANNELS.list, async (): Promise<ListConversationsResult> => {
    try {
      return { status: 'ok', conversations: await module.listConversations() }
    } catch (error) {
      return { status: 'error', error: toSafeRequestError(error) }
    }
  })

  ipcMain.handle(
    CONVERSATION_CHANNELS.load,
    async (_event, rawInput: unknown): Promise<LoadConversationResult> => {
      const input = loadConversationInputSchema.parse(rawInput)
      try {
        return { status: 'ok', ...(await module.loadConversation(input.sessionId)) }
      } catch (error) {
        return { status: 'error', error: toSafeRequestError(error) }
      }
    }
  )

  ipcMain.handle(
    CONVERSATION_CHANNELS.send,
    async (event, rawInput: unknown): Promise<SendMessageResult> => {
      const input = sendMessageInputSchema.parse(rawInput)
      const sender = event.sender

      try {
        return await module.sendMessage(input, (conversationEvent) => {
          sendEvent(sender, conversationEventSchema.parse(conversationEvent))
        })
      } catch (error) {
        throw toSafeIpcError(error)
      }
    }
  )

  ipcMain.handle(CONVERSATION_CHANNELS.cancel, (_event, rawInput: unknown): void => {
    const input = cancelMessageInputSchema.parse(rawInput)
    module.cancelMessage(input.requestId)
  })
}

function sendEvent(sender: WebContents, event: unknown): void {
  if (!sender.isDestroyed()) {
    sender.send(CONVERSATION_CHANNELS.event, event)
  }
}
