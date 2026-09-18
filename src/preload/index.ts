import {
  VOCABULARY_TRANSFER_CHANNELS as VT,
  confirmImportSchema,
  startImportSchema,
  taskInputSchema,
  cancelImportSchema,
  fileResultSchema,
  previewResultSchema,
  taskResultSchema,
  importTaskSchema
} from '../shared/vocabulary-transfer'
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
import {
  synonymListInputSchema,
  synonymListResultSchema,
  SYNONYM_CHANNELS
} from '../shared/synonym'
import {
  vocabularyPracticeCancelInputSchema,
  vocabularyPracticeCancelResultSchema,
  vocabularyPracticeReviewInputSchema,
  vocabularyPracticeReviewResultSchema,
  vocabularyPracticeStartInputSchema,
  vocabularyPracticeStartResultSchema,
  VOCABULARY_PRACTICE_CHANNELS
} from '../shared/vocabulary-practice'
import {
  sentencePracticeCancelInputSchema,
  sentencePracticeCancelResultSchema,
  sentencePracticeCloseInputSchema,
  sentencePracticeCloseResultSchema,
  sentencePracticeHintsInputSchema,
  sentencePracticeHintsResultSchema,
  sentencePracticeReviewInputSchema,
  sentencePracticeReviewResultSchema,
  sentencePracticeStartInputSchema,
  sentencePracticeStartResultSchema,
  SENTENCE_PRACTICE_CHANNELS
} from '../shared/sentence-practice'
import {
  ERROR_LOG_CHANNELS,
  errorReportResultSchema,
  rendererErrorReportSchema,
  type RendererErrorReport
} from '../shared/error-report'
import type { ZodIssue } from 'zod'

// preload 捕获的桥接错误：尽力上报到 Main 的公共错误日志，失败静默放弃，
// 不再触发新的上报（避免循环）。
const reportBridgeError = (report: RendererErrorReport): void => {
  void ipcRenderer.invoke(ERROR_LOG_CHANNELS.report, report).catch(() => {})
}

// 只上报 issue 的 path 与 code：message 可能回显事件载荷内容。
const issueSummary = (issues: ZodIssue[]): Array<{ path: PropertyKey[]; code: string }> =>
  issues.map(({ path, code }) => ({ path, code }))

const api: LingoMateApi = {
  reportError: async (rawInput) => {
    const input = rendererErrorReportSchema.parse(rawInput)
    const result: unknown = await ipcRenderer.invoke(ERROR_LOG_CHANNELS.report, input)
    return errorReportResultSchema.parse(result)
  },
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
    async downloadTemplate() {
      return fileResultSchema.parse(await ipcRenderer.invoke(VT.template))
    },
    async exportExcel() {
      return fileResultSchema.parse(await ipcRenderer.invoke(VT.export))
    },
    async previewExcel() {
      return previewResultSchema.parse(await ipcRenderer.invoke(VT.preview))
    },
    async confirmExcel(input) {
      return taskResultSchema.parse(
        await ipcRenderer.invoke(VT.confirm, confirmImportSchema.parse(input))
      )
    },
    async startImport(input) {
      return taskResultSchema.parse(
        await ipcRenderer.invoke(VT.start, startImportSchema.parse(input))
      )
    },
    async getImportTask(input) {
      return taskResultSchema.parse(await ipcRenderer.invoke(VT.task, taskInputSchema.parse(input)))
    },
    async cancelImport(input) {
      return taskResultSchema.parse(
        await ipcRenderer.invoke(VT.cancel, cancelImportSchema.parse(input))
      )
    },
    onImportProgress(listener) {
      const handler = (_event: Electron.IpcRendererEvent, raw: unknown): void => {
        const parsed = importTaskSchema.safeParse(raw)
        if (parsed.success) listener(parsed.data)
        else {
          // 推送任务形状不符合协议：丢弃事件并上报安全元信息。
          reportBridgeError({
            source: 'preload',
            module: 'vocabulary-transfer',
            operation: 'progress-parse',
            message: 'received an import progress event that failed schema validation',
            context: { issues: issueSummary(parsed.error.issues) }
          })
        }
      }
      ipcRenderer.on(VT.event, handler)
      return () => {
        ipcRenderer.removeListener(VT.event, handler)
      }
    },
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
  synonym: {
    async list(rawInput) {
      const input = synonymListInputSchema.parse(rawInput)
      const result: unknown = await ipcRenderer.invoke(SYNONYM_CHANNELS.list, input)
      return synonymListResultSchema.parse(result)
    }
  },
  vocabularyPractice: {
    async start(rawInput) {
      const input = vocabularyPracticeStartInputSchema.parse(rawInput)
      const result: unknown = await ipcRenderer.invoke(VOCABULARY_PRACTICE_CHANNELS.start, input)
      return vocabularyPracticeStartResultSchema.parse(result)
    },
    async review(rawInput) {
      const input = vocabularyPracticeReviewInputSchema.parse(rawInput)
      const result: unknown = await ipcRenderer.invoke(VOCABULARY_PRACTICE_CHANNELS.review, input)
      return vocabularyPracticeReviewResultSchema.parse(result)
    },
    async cancel(rawInput) {
      const input = vocabularyPracticeCancelInputSchema.parse(rawInput)
      const result: unknown = await ipcRenderer.invoke(VOCABULARY_PRACTICE_CHANNELS.cancel, input)
      return vocabularyPracticeCancelResultSchema.parse(result)
    }
  },
  sentencePractice: {
    async start(rawInput) {
      const input = sentencePracticeStartInputSchema.parse(rawInput)
      const result: unknown = await ipcRenderer.invoke(SENTENCE_PRACTICE_CHANNELS.start, input)
      return sentencePracticeStartResultSchema.parse(result)
    },
    async hints(rawInput) {
      const input = sentencePracticeHintsInputSchema.parse(rawInput)
      const result: unknown = await ipcRenderer.invoke(SENTENCE_PRACTICE_CHANNELS.hints, input)
      return sentencePracticeHintsResultSchema.parse(result)
    },
    async review(rawInput) {
      const input = sentencePracticeReviewInputSchema.parse(rawInput)
      const result: unknown = await ipcRenderer.invoke(SENTENCE_PRACTICE_CHANNELS.review, input)
      return sentencePracticeReviewResultSchema.parse(result)
    },
    async cancel(rawInput) {
      const input = sentencePracticeCancelInputSchema.parse(rawInput)
      const result: unknown = await ipcRenderer.invoke(SENTENCE_PRACTICE_CHANNELS.cancel, input)
      return sentencePracticeCancelResultSchema.parse(result)
    },
    async close(rawInput) {
      const input = sentencePracticeCloseInputSchema.parse(rawInput)
      const result: unknown = await ipcRenderer.invoke(SENTENCE_PRACTICE_CHANNELS.close, input)
      return sentencePracticeCloseResultSchema.parse(result)
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
          // 事件不符合协议：丢弃并上报安全元信息（不含事件载荷）。
          reportBridgeError({
            source: 'preload',
            module: 'conversation',
            operation: 'event-parse',
            message: 'received a conversation event that failed schema validation',
            context: { issues: issueSummary(event.error.issues) }
          })
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
