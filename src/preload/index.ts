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
  runConversationSkillInputSchema,
  runConversationSkillResultSchema,
  sendMessageInputSchema,
  sendMessageResultSchema,
  type LingoMateApi
} from '../shared/conversation'
import {
  cancelModelsTestInputSchema,
  cancelModelsTestResultSchema,
  createModelConfigInputSchema,
  createModelConfigResultSchema,
  deleteModelConfigInputSchema,
  deleteModelConfigResultSchema,
  listModelsConfigsResultSchema,
  MODELS_CHANNELS,
  setActiveModelConfigInputSchema,
  setActiveModelConfigResultSchema,
  testDraftModelsConnectionInputSchema,
  testModelsConnectionResultSchema,
  testSavedModelsConnectionInputSchema,
  updateModelConfigInputSchema,
  updateModelConfigResultSchema
} from '../shared/models'
import {
  getLanguageSettingsResultSchema,
  PREFERENCES_CHANNELS,
  setTargetLanguageInputSchema,
  setTargetLanguageResultSchema,
  setUiLanguageInputSchema,
  setUiLanguageResultSchema
} from '../shared/preferences'
import {
  USAGE_CHANNELS,
  usageOverviewInputSchema,
  usageOverviewResultSchema
} from '../shared/usage'
import {
  deleteVocabularyInputSchema,
  deleteVocabularyResultSchema,
  listVocabularyInputSchema,
  listVocabularyResultSchema,
  VOCABULARY_CHANNELS
} from '../shared/vocabulary'
import {
  deletePhraseInputSchema,
  deletePhraseResultSchema,
  listPhraseInputSchema,
  listPhraseResultSchema,
  PHRASE_CHANNELS
} from '../shared/phrase'

const api: LingoMateApi = {
  preferences: {
    async getLanguageSettings() {
      const result: unknown = await ipcRenderer.invoke(PREFERENCES_CHANNELS.getLanguageSettings)
      return getLanguageSettingsResultSchema.parse(result)
    },
    async setUiLanguage(rawInput) {
      const input = setUiLanguageInputSchema.parse(rawInput)
      const result: unknown = await ipcRenderer.invoke(PREFERENCES_CHANNELS.setUiLanguage, input)
      return setUiLanguageResultSchema.parse(result)
    },
    async setTargetLanguage(rawInput) {
      const input = setTargetLanguageInputSchema.parse(rawInput)
      const result: unknown = await ipcRenderer.invoke(
        PREFERENCES_CHANNELS.setTargetLanguage,
        input
      )
      return setTargetLanguageResultSchema.parse(result)
    }
  },
  models: {
    async listConfigs() {
      const result: unknown = await ipcRenderer.invoke(MODELS_CHANNELS.listConfigs)
      return listModelsConfigsResultSchema.parse(result)
    },
    async createConfig(rawInput) {
      const input = createModelConfigInputSchema.parse(rawInput)
      const result: unknown = await ipcRenderer.invoke(MODELS_CHANNELS.createConfig, input)
      return createModelConfigResultSchema.parse(result)
    },
    async updateConfig(rawInput) {
      const input = updateModelConfigInputSchema.parse(rawInput)
      const result: unknown = await ipcRenderer.invoke(MODELS_CHANNELS.updateConfig, input)
      return updateModelConfigResultSchema.parse(result)
    },
    async deleteConfig(rawInput) {
      const input = deleteModelConfigInputSchema.parse(rawInput)
      const result: unknown = await ipcRenderer.invoke(MODELS_CHANNELS.deleteConfig, input)
      return deleteModelConfigResultSchema.parse(result)
    },
    async setActiveConfig(rawInput) {
      const input = setActiveModelConfigInputSchema.parse(rawInput)
      const result: unknown = await ipcRenderer.invoke(MODELS_CHANNELS.setActiveConfig, input)
      return setActiveModelConfigResultSchema.parse(result)
    },
    async testSavedConnection(rawInput) {
      const input = testSavedModelsConnectionInputSchema.parse(rawInput)
      const result: unknown = await ipcRenderer.invoke(MODELS_CHANNELS.testSavedConnection, input)
      return testModelsConnectionResultSchema.parse(result)
    },
    async testDraftConnection(rawInput) {
      const input = testDraftModelsConnectionInputSchema.parse(rawInput)
      const result: unknown = await ipcRenderer.invoke(MODELS_CHANNELS.testDraftConnection, input)
      return testModelsConnectionResultSchema.parse(result)
    },
    async cancelTest(rawInput) {
      const input = cancelModelsTestInputSchema.parse(rawInput)
      const result: unknown = await ipcRenderer.invoke(MODELS_CHANNELS.cancelTest, input)
      return cancelModelsTestResultSchema.parse(result)
    }
  },
  usage: {
    async getOverview(rawInput) {
      const input = usageOverviewInputSchema.parse(rawInput)
      const result: unknown = await ipcRenderer.invoke(USAGE_CHANNELS.getOverview, input)
      return usageOverviewResultSchema.parse(result)
    }
  },
  vocabulary: {
    async list(rawInput) {
      const input = listVocabularyInputSchema.parse(rawInput)
      const result: unknown = await ipcRenderer.invoke(VOCABULARY_CHANNELS.list, input)
      return listVocabularyResultSchema.parse(result)
    },
    async delete(rawInput) {
      const input = deleteVocabularyInputSchema.parse(rawInput)
      const result: unknown = await ipcRenderer.invoke(VOCABULARY_CHANNELS.delete, input)
      return deleteVocabularyResultSchema.parse(result)
    }
  },
  phrase: {
    async list(rawInput) {
      const input = listPhraseInputSchema.parse(rawInput)
      const result: unknown = await ipcRenderer.invoke(PHRASE_CHANNELS.list, input)
      return listPhraseResultSchema.parse(result)
    },
    async delete(rawInput) {
      const input = deletePhraseInputSchema.parse(rawInput)
      const result: unknown = await ipcRenderer.invoke(PHRASE_CHANNELS.delete, input)
      return deletePhraseResultSchema.parse(result)
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
    async runSkill(rawInput) {
      const input = runConversationSkillInputSchema.parse(rawInput)
      const result: unknown = await ipcRenderer.invoke(CONVERSATION_CHANNELS.runSkill, input)
      return runConversationSkillResultSchema.parse(result)
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
