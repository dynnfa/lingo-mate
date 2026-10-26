import { utilityProcess } from 'electron'
import { join } from 'node:path'
import type { ErrorLogger } from '../error-logger'
import { SpeechService } from '../../core/speech/speech-service'
import { SpeechError } from '../../core/speech/speech-synthesizer'
import {
  type SpeechAudio,
  type SpeechInput,
  type SpeechRuntimeStatus,
  type SpeechSettings
} from '../../shared/speech'
import { SpeechAssets } from './speech-assets'
import { SpeechSettingsStore } from './speech-settings-store'
import { HeadTtsProcess } from './headtts-process'

export interface SpeechHost {
  synthesize(input: SpeechInput, signal: AbortSignal): Promise<SpeechAudio>
  getSettings(): Promise<SpeechSettings>
  updateSettings(settings: SpeechSettings): Promise<SpeechSettings>
  getRuntimeStatus(): Promise<SpeechRuntimeStatus>
  installResources(signal: AbortSignal): Promise<void>
  subscribe(listener: (status: SpeechRuntimeStatus) => void): () => void
  dispose(): void
}

export function createSpeechHost(userData: string, logger: ErrorLogger): SpeechHost {
  const assets = new SpeechAssets(join(userData, 'speech'))
  const settings = new SpeechSettingsStore(join(userData, 'speech', 'settings.json'))
  let status: SpeechRuntimeStatus | undefined
  let installing = false
  let active = 0
  const listeners = new Set<(status: SpeechRuntimeStatus) => void>()
  const update = (value: SpeechRuntimeStatus): void => {
    status = value
    for (const listener of listeners) listener(value)
  }
  const runtime = new HeadTtsProcess(
    () => {
      const env: NodeJS.ProcessEnv = { NODE_ENV: 'production' }
      for (const key of ['TMPDIR', 'TEMP', 'TMP', 'SYSTEMROOT', 'WINDIR']) {
        if (process.env[key]) env[key] = process.env[key]
      }
      return utilityProcess.fork(join(__dirname, 'headtts-entry.js'), [], {
        env,
        stdio: 'pipe',
        serviceName: 'Lingo Mate Speech'
      })
    },
    () => assets.requireInstalled(),
    update,
    (output) =>
      logger.log({ source: 'main', module: 'speech', operation: 'runtime-output', message: output })
  )
  const service = new SpeechService(runtime)
  return {
    async synthesize(input, signal) {
      if (installing) throw new SpeechError('BUSY')
      const snapshot = await settings.read()
      active++
      try {
        return await service.synthesize(input, snapshot, signal)
      } finally {
        active--
      }
    },
    getSettings: () => settings.read(),
    updateSettings: (input) => settings.write(input),
    async getRuntimeStatus() {
      if (!status) {
        const installed = await assets.isInstalled()
        if (!status) update({ phase: installed ? 'unloaded' : 'not-installed', progress: 0 })
      }
      return status!
    },
    async installResources(signal) {
      if (installing || active) throw new SpeechError('BUSY')
      installing = true
      runtime.dispose()
      update({ phase: 'installing', progress: 0 })
      let last = -1
      try {
        await assets.install(signal, (progress) => {
          const rounded = Math.floor(progress * 100)
          if (rounded !== last) {
            last = rounded
            update({ phase: 'installing', progress })
          }
        })
        update({ phase: 'unloaded', progress: 1 })
      } catch (error) {
        update({
          phase: 'failed',
          progress: 0,
          error: error instanceof SpeechError ? error.code : 'INSTALL_FAILED'
        })
        throw error
      } finally {
        installing = false
      }
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    dispose() {
      runtime.dispose()
      listeners.clear()
    }
  }
}
