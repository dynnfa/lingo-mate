import type { WebContents } from 'electron'
import { ipcMain } from 'electron'
import type { ConversationSession } from '../core/conversation/conversation-session'
import {
  cancelMessageInputSchema,
  CONVERSATION_CHANNELS,
  conversationEventSchema,
  sendMessageInputSchema,
  type SendMessageResult
} from '../shared/conversation'

export function registerConversationIpc(session: ConversationSession): void {
  ipcMain.handle(CONVERSATION_CHANNELS.send, (event, rawInput: unknown): SendMessageResult => {
    const input = sendMessageInputSchema.parse(rawInput)
    const sender = event.sender

    session.start(input, (conversationEvent) => {
      sendEvent(sender, conversationEventSchema.parse(conversationEvent))
    })

    return { requestId: input.requestId, accepted: true }
  })

  ipcMain.handle(CONVERSATION_CHANNELS.cancel, (_event, rawInput: unknown): void => {
    const input = cancelMessageInputSchema.parse(rawInput)
    session.cancel(input.requestId)
  })
}

function sendEvent(sender: WebContents, event: unknown): void {
  if (!sender.isDestroyed()) {
    sender.send(CONVERSATION_CHANNELS.event, event)
  }
}
