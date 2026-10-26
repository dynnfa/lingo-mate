import { ipcRenderer } from 'electron'
import {
  SPEECH_CHANNELS as C,
  speechInputSchema,
  speechSynthesisResultSchema,
  speechRequestSchema,
  speechActionResultSchema,
  speechSettingsResultSchema,
  speechSettingsSchema,
  speechStatusResultSchema,
  speechRuntimeStatusSchema,
  type SpeechApi
} from '../shared/speech'

export function createSpeechApi(): SpeechApi {
  return {
    async synthesize(raw) {
      return speechSynthesisResultSchema.parse(
        await ipcRenderer.invoke(C.synthesize, speechInputSchema.parse(raw))
      )
    },
    async cancel(raw) {
      return speechActionResultSchema.parse(
        await ipcRenderer.invoke(C.cancel, speechRequestSchema.parse(raw))
      )
    },
    async getSettings() {
      return speechSettingsResultSchema.parse(await ipcRenderer.invoke(C.getSettings))
    },
    async updateSettings(raw) {
      return speechSettingsResultSchema.parse(
        await ipcRenderer.invoke(C.updateSettings, speechSettingsSchema.parse(raw))
      )
    },
    async getRuntimeStatus() {
      return speechStatusResultSchema.parse(await ipcRenderer.invoke(C.getRuntimeStatus))
    },
    async installResources() {
      return speechActionResultSchema.parse(await ipcRenderer.invoke(C.installResources))
    },
    async cancelInstall() {
      return speechActionResultSchema.parse(await ipcRenderer.invoke(C.cancelInstall))
    },
    onStatus(listener) {
      const receive = (_event: unknown, raw: unknown): void => {
        const parsed = speechRuntimeStatusSchema.safeParse(raw)
        if (parsed.success) listener(parsed.data)
      }
      ipcRenderer.on(C.status, receive)
      return () => {
        ipcRenderer.removeListener(C.status, receive)
      }
    }
  }
}
