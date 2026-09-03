import { contextBridge, ipcRenderer } from 'electron'
import {
  cancelMessageInputSchema,
  CONVERSATION_CHANNELS,
  conversationEventSchema,
  sendMessageInputSchema,
  sendMessageResultSchema,
  type LingoMateApi
} from '../shared/conversation'

const api: LingoMateApi = {
  conversation: {
    async send(rawInput) {
      const input = sendMessageInputSchema.parse(rawInput)
      const result: unknown = await ipcRenderer.invoke(CONVERSATION_CHANNELS.send, input)
      return sendMessageResultSchema.parse(result)
    },
    async cancel(rawInput) {
      const input = cancelMessageInputSchema.parse(rawInput)
      await ipcRenderer.invoke(CONVERSATION_CHANNELS.cancel, input)
    },
    onEvent(listener) {
      const handler = (_event: Electron.IpcRendererEvent, rawEvent: unknown): void => {
        const event = conversationEventSchema.safeParse(rawEvent)
        if (event.success) {
          listener(event.data)
        } else {
          console.error('收到无法解析的会话事件', event.error)
        }
      }

      ipcRenderer.on(CONVERSATION_CHANNELS.event, handler)
      return () => ipcRenderer.removeListener(CONVERSATION_CHANNELS.event, handler)
    }
  }
}

// Use `contextBridge` APIs to expose Electron APIs to
// renderer only if context isolation is enabled, otherwise
// just add to the DOM global.
contextBridge.exposeInMainWorld('api', api)
