import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, mkdir, mkdtemp, open, rename, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import manifest from '../../../resources/speech/headtts/manifest.json'
import { SpeechError } from '../../core/speech/speech-synthesizer'
import { SPEECH_IDENTITY } from '../../shared/speech'

export const speechManifest = manifest
export class SpeechAssets {
  readonly modelPath: string
  constructor(
    readonly root: string,
    private readonly download: typeof fetch = fetch
  ) {
    this.modelPath = join(root, 'models', SPEECH_IDENTITY.revision)
  }
  async install(signal: AbortSignal, progress: (fraction: number) => void): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 })
    const staging = await mkdtemp(join(this.root, 'install-'))
    const combined = AbortSignal.any([signal, AbortSignal.timeout(600_000)])
    const total = manifest.files.reduce((sum, file) => sum + file.bytes, 0)
    let loaded = 0
    try {
      for (const file of manifest.files) {
        combined.throwIfAborted()
        const response = await this.download(
          `https://huggingface.co/${manifest.model}/resolve/${manifest.revision}/${file.path}`,
          { signal: combined, credentials: 'omit' }
        )
        if (!response.ok || !response.body) throw new SpeechError('INSTALL_FAILED')
        const target = join(staging, file.path)
        await mkdir(dirname(target), { recursive: true, mode: 0o700 })
        const handle = await open(target, 'wx', 0o600)
        const reader = response.body.getReader()
        let bytes = 0
        const hash = createHash('sha256')
        try {
          while (true) {
            const { done, value } = await reader.read()
            if (done) break
            combined.throwIfAborted()
            bytes += value.byteLength
            if (bytes > file.bytes) throw new SpeechError('INSTALL_FAILED')
            hash.update(value)
            await handle.writeFile(value)
            loaded += value.byteLength
            progress(loaded / total)
          }
        } finally {
          await reader.cancel().catch(() => undefined)
          await handle.close()
        }
        if (bytes !== file.bytes || hash.digest('hex') !== file.sha256)
          throw new SpeechError('INSTALL_FAILED')
      }
      await this.verify(staging)
      combined.throwIfAborted()
      await mkdir(dirname(this.modelPath), { recursive: true, mode: 0o700 })
      const backup = join(this.root, `backup-${randomUUID()}`)
      let previous = false
      try {
        await rename(this.modelPath, backup)
        previous = true
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause
      }
      try {
        await rename(staging, this.modelPath)
      } catch (cause) {
        if (previous) {
          try {
            await rename(backup, this.modelPath)
          } catch (rollbackError) {
            // Keep the backup for recovery if the filesystem also rejects rollback.
            throw new AggregateError([cause, rollbackError], 'Speech resource rollback failed')
          }
        }
        throw cause
      }
      if (previous) await rm(backup, { recursive: true, force: true })
      progress(1)
    } catch (cause) {
      throw new SpeechError(signal.aborted ? 'CANCELLED' : 'INSTALL_FAILED', { cause })
    } finally {
      await rm(staging, { recursive: true, force: true })
    }
  }
  async isInstalled(): Promise<boolean> {
    try {
      await this.verify(this.modelPath)
      return true
    } catch {
      return false
    }
  }
  async requireInstalled(): Promise<string> {
    try {
      await this.verify(this.modelPath)
      return this.modelPath
    } catch (cause) {
      throw new SpeechError('NOT_INSTALLED', { cause })
    }
  }
  async verify(directory: string): Promise<void> {
    if (
      manifest.dtype !== SPEECH_IDENTITY.dtype ||
      manifest.revision !== SPEECH_IDENTITY.revision ||
      manifest.device !== 'cpu'
    )
      throw new SpeechError('RUNTIME_FAILED')
    for (const file of manifest.files) {
      const path = join(directory, file.path)
      const info = await lstat(path)
      if (!info.isFile() || info.isSymbolicLink() || info.size !== file.bytes)
        throw new SpeechError('NOT_INSTALLED')
      const hash = createHash('sha256')
      for await (const chunk of createReadStream(path)) hash.update(chunk)
      if (hash.digest('hex') !== file.sha256) throw new SpeechError('NOT_INSTALLED')
    }
  }
}
