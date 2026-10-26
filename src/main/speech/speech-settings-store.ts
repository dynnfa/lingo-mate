import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  DEFAULT_SPEECH_SETTINGS,
  speechSettingsSchema,
  type SpeechSettings
} from '../../shared/speech'
import { SpeechError } from '../../core/speech/speech-synthesizer'

export class SpeechSettingsStore {
  private tail: Promise<unknown> = Promise.resolve()
  constructor(private readonly path: string) {}
  async read(): Promise<SpeechSettings> {
    await this.tail
    try {
      return speechSettingsSchema.parse(JSON.parse(await readFile(this.path, 'utf8')))
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return { ...DEFAULT_SPEECH_SETTINGS }
      throw new SpeechError('SETTINGS_FAILED', { cause })
    }
  }
  async write(raw: SpeechSettings): Promise<SpeechSettings> {
    const settings = speechSettingsSchema.parse(raw)
    const task = this.tail.then(async () => {
      const temporary = `${this.path}.${randomUUID()}.tmp`
      try {
        await mkdir(dirname(this.path), { recursive: true, mode: 0o700 })
        await writeFile(temporary, JSON.stringify(settings), { mode: 0o600, flag: 'wx' })
        await rename(temporary, this.path)
        return settings
      } catch (cause) {
        throw new SpeechError('SETTINGS_FAILED', { cause })
      }
    })
    this.tail = task.catch(() => undefined)
    return task
  }
}
