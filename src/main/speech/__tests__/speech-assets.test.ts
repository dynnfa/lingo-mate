import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SpeechAssets } from '../speech-assets'

const fixture = vi.hoisted(() => ({ contents: 'verified FP32 resource fixture' }))
vi.mock('../../../../resources/speech/headtts/manifest.json', async (importOriginal) => {
  const { default: manifest } = await importOriginal<{
    default: typeof import('../../../../resources/speech/headtts/manifest.json')
  }>()
  const { createHash } = await import('node:crypto')
  return {
    default: {
      ...manifest,
      files: [
        {
          path: 'model.bin',
          bytes: Buffer.byteLength(fixture.contents),
          sha256: createHash('sha256').update(fixture.contents).digest('hex')
        }
      ]
    }
  }
})
vi.mock('node:fs/promises', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs/promises')>()
  return { ...fs, rename: vi.fn(fs.rename) }
})

const roots: string[] = []
beforeEach(async () => {
  const fs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
  vi.mocked(rename).mockImplementation(fs.rename)
})
afterEach(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })))
})
describe('speech resources', () => {
  it.each(['backup', 'activation'] as const)(
    'preserves the previous installation when %s fails',
    async (stage) => {
      const root = await mkdtemp(join(tmpdir(), 'lingo-speech-assets-'))
      roots.push(root)
      const assets = new SpeechAssets(root, async () => new Response(fixture.contents))
      await mkdir(assets.modelPath, { recursive: true })
      await writeFile(join(assets.modelPath, 'model.bin'), fixture.contents)
      const marker = join(assets.modelPath, 'previous-installation')
      await writeFile(marker, 'keep the previous resources')
      const fs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
      const activationError = Object.assign(new Error('Directory switch denied'), {
        code: 'EACCES'
      })
      vi.mocked(rename).mockImplementation(async (from, to) => {
        if (
          stage === 'backup'
            ? from === assets.modelPath
            : String(from).startsWith(join(root, 'install-')) && to === assets.modelPath
        )
          throw activationError
        await fs.rename(from, to)
      })
      await expect(assets.install(new AbortController().signal, () => {})).rejects.toMatchObject({
        code: 'INSTALL_FAILED',
        cause: activationError
      })
      expect(await assets.isInstalled()).toBe(true)
      expect(await readFile(marker, 'utf8')).toBe('keep the previous resources')
      expect((await readdir(root)).filter((name) => /^(install|backup)-/.test(name))).toEqual([])
    }
  )

  it.each([false, true])(
    'activates verified resources and cleans staging (reinstall: %s)',
    async (reinstall) => {
      const root = await mkdtemp(join(tmpdir(), 'lingo-speech-assets-'))
      roots.push(root)
      const assets = new SpeechAssets(root, async () => new Response(fixture.contents))
      if (reinstall) {
        await mkdir(assets.modelPath, { recursive: true })
        await writeFile(join(assets.modelPath, 'model.bin'), fixture.contents)
        await writeFile(join(assets.modelPath, 'previous-installation'), 'old marker')
      }
      const progress = vi.fn()
      await assets.install(new AbortController().signal, progress)
      expect(await assets.requireInstalled()).toBe(assets.modelPath)
      expect(await readdir(assets.modelPath)).toEqual(['model.bin'])
      expect((await readdir(root)).filter((name) => /^(install|backup)-/.test(name))).toEqual([])
      expect(progress).toHaveBeenLastCalledWith(1)
    }
  )

  it('retains the backup and both failure causes if rollback is also rejected', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lingo-speech-assets-'))
    roots.push(root)
    const assets = new SpeechAssets(root, async () => new Response(fixture.contents))
    await mkdir(assets.modelPath, { recursive: true })
    await writeFile(join(assets.modelPath, 'model.bin'), fixture.contents)
    const fs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
    const activationError = new Error('Activation denied')
    const rollbackError = new Error('Rollback denied')
    vi.mocked(rename).mockImplementation(async (from, to) => {
      if (to === assets.modelPath) {
        if (String(from).startsWith(join(root, 'install-'))) throw activationError
        throw rollbackError
      }
      await fs.rename(from, to)
    })
    await expect(assets.install(new AbortController().signal, () => {})).rejects.toMatchObject({
      code: 'INSTALL_FAILED',
      cause: { errors: [activationError, rollbackError] }
    })
    const backups = (await readdir(root)).filter((name) => name.startsWith('backup-'))
    expect(backups).toHaveLength(1)
    expect(await readFile(join(root, backups[0], 'model.bin'), 'utf8')).toBe(fixture.contents)
    expect((await readdir(root)).filter((name) => name.startsWith('install-'))).toEqual([])
  })

  it('reports missing FP32 resources without attempting network access', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lingo-speech-assets-'))
    roots.push(root)
    const assets = new SpeechAssets(root)
    expect(await assets.isInstalled()).toBe(false)
    await expect(assets.requireInstalled()).rejects.toMatchObject({ code: 'NOT_INSTALLED' })
  })
  it('rejects a corrupt download and never enables a partial installation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lingo-speech-assets-'))
    roots.push(root)
    const assets = new SpeechAssets(root, async () => new Response('corrupt'))
    await expect(assets.install(new AbortController().signal, () => {})).rejects.toMatchObject({
      code: 'INSTALL_FAILED'
    })
    expect(await assets.isInstalled()).toBe(false)
    expect((await readdir(root)).filter((name) => name.startsWith('install-'))).toEqual([])
  })
})
