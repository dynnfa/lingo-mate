import { contextBridge, ipcRenderer } from 'electron'
import {
  cancelMessageInputSchema,
  cancelMessageResultSchema,
  CONVERSATION_CHANNELS,
  conversationEventSchema,
  createConversationResultSchema,
  listConversationsResultSchema,
  loadConversationInputSchema,
  loadConversationResultSchema,
  retryMessageInputSchema,
  retryMessageResultSchema,
  sendMessageInputSchema,
  sendMessageResultSchema,
  type LingoMateApi
} from '../shared/conversation'
import {
  cancelModelsTestInputSchema,
  cancelModelsTestResultSchema,
  clearModelsSettingsResultSchema,
  getModelsSettingsResultSchema,
  MODELS_CHANNELS,
  saveModelsSettingsInputSchema,
  saveModelsSettingsResultSchema,
  testModelsConnectionInputSchema,
  testModelsConnectionResultSchema
} from '../shared/models'
import {
  getLocaleResultSchema,
  PREFERENCES_CHANNELS,
  setLocaleInputSchema,
  setLocaleResultSchema
} from '../shared/preferences'

const api: LingoMateApi = {
  preferences: {
    async getLocale() {
      const result: unknown = await ipcRenderer.invoke(PREFERENCES_CHANNELS.getLocale)
      return getLocaleResultSchema.parse(result)
    },
    async setLocale(rawInput) {
      const input = setLocaleInputSchema.parse(rawInput)
      const result: unknown = await ipcRenderer.invoke(PREFERENCES_CHANNELS.setLocale, input)
      return setLocaleResultSchema.parse(result)
    }
  },
  models: {
    async getSettings() {
      const result: unknown = await ipcRenderer.invoke(MODELS_CHANNELS.getSettings)
      return getModelsSettingsResultSchema.parse(result)
    },
    async saveSettings(rawInput) {
      const input = saveModelsSettingsInputSchema.parse(rawInput)
      const result: unknown = await ipcRenderer.invoke(MODELS_CHANNELS.saveSettings, input)
      return saveModelsSettingsResultSchema.parse(result)
    },
    async testConnection(rawInput) {
      const input = testModelsConnectionInputSchema.parse(rawInput)
      const result: unknown = await ipcRenderer.invoke(MODELS_CHANNELS.testConnection, input)
      return testModelsConnectionResultSchema.parse(result)
    },
    async cancelTest(rawInput) {
      const input = cancelModelsTestInputSchema.parse(rawInput)
      const result: unknown = await ipcRenderer.invoke(MODELS_CHANNELS.cancelTest, input)
      return cancelModelsTestResultSchema.parse(result)
    },
    async clearSettings() {
      const result: unknown = await ipcRenderer.invoke(MODELS_CHANNELS.clearSettings)
      return clearModelsSettingsResultSchema.parse(result)
    }
  },
  conversation: {
    async create() {
      const result: unknown = await ipcRenderer.invoke(CONVERSATION_CHANNELS.create)
      return createConversationResultSchema.parse(result)
    },
    async list() {
      const result: unknown = await ipcRenderer.invoke(CONVERSATION_CHANNELS.list)
      return listConversationsResultSchema.parse(result)
    },
    async load(rawInput) {
      const input = loadConversationInputSchema.parse(rawInput)
      const result: unknown = await ipcRenderer.invoke(CONVERSATION_CHANNELS.load, input)
      return loadConversationResultSchema.parse(result)
    },
    async send(rawInput) {
      const input = sendMessageInputSchema.parse(rawInput)
      const result: unknown = await ipcRenderer.invoke(CONVERSATION_CHANNELS.send, input)
      return sendMessageResultSchema.parse(result)
    },
    async retry(rawInput) {
      const input = retryMessageInputSchema.parse(rawInput)
      const result: unknown = await ipcRenderer.invoke(CONVERSATION_CHANNELS.retry, input)
      return retryMessageResultSchema.parse(result)
    },
    async cancel(rawInput) {
      const input = cancelMessageInputSchema.parse(rawInput)
      const result: unknown = await ipcRenderer.invoke(CONVERSATION_CHANNELS.cancel, input)
      return cancelMessageResultSchema.parse(result)
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
