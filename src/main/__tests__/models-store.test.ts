import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const safeStorageMock = vi.hoisted(() => ({
  isEncryptionAvailable: vi.fn(() => true),
  encryptString: vi.fn((plainText: string) => Buffer.from(`mock:${plainText}`)),
  decryptString: vi.fn((buffer: Buffer) => buffer.toString('utf8').replace(/^mock:/, ''))
}))

vi.mock('electron', () => ({ safeStorage: safeStorageMock }))

import { createFileModelsConfigStore, createSafeStorageCredentialVault } from '../models-store'

let dataDir: string

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'lingo-mate-models-store-'))
})

afterEach(async () => {
  await rm(dataDir, { force: true, recursive: true })
  vi.clearAllMocks()
})

describe('createFileModelsConfigStore', () => {
  it('returns undefined when no record exists yet', () => {
    const store = createFileModelsConfigStore(join(dataDir, 'models.json'))
    expect(store.read()).toBeUndefined()
  })

  it('round-trips a full record and replaces it atomically', async () => {
    const filePath = join(dataDir, 'models.json')
    const store = createFileModelsConfigStore(filePath)
    const record = {
      schemaVersion: 1,
      protocol: 'openai-compatible',
      baseUrl: 'https://api.example.com/v1',
      modelId: 'gpt-test'
    }

    store.write(record)
    expect(store.read()).toEqual(record)

    store.write(null)
    expect(store.read()).toBeNull()

    // 临时文件已清理，目录内只剩记录文件
    const { readdir } = await import('node:fs/promises')
    expect(await readdir(dataDir)).toEqual(['models.json'])
  })

  it('propagates JSON parse errors so callers treat them as read failures', async () => {
    const filePath = join(dataDir, 'models.json')
    await writeFile(filePath, '{broken', 'utf8')

    expect(() => createFileModelsConfigStore(filePath).read()).toThrow()
  })

  it('keeps the old record when a write fails', async () => {
    const filePath = join(dataDir, 'models.json')
    const store = createFileModelsConfigStore(filePath)
    store.write({
      schemaVersion: 1,
      protocol: 'openai-compatible',
      baseUrl: 'https://a.example.com',
      modelId: 'm'
    })

    // 把记录文件改成目录使 rename 失败，模拟持久化故障
    const nextFile = join(dataDir, 'next.json')
    const nextStore = createFileModelsConfigStore(nextFile)
    const { mkdir } = await import('node:fs/promises')
    await mkdir(nextFile)
    expect(() => nextStore.write(null)).toThrow()

    expect(await readFile(filePath, 'utf8')).toContain('a.example.com')
  })
})

describe('createSafeStorageCredentialVault', () => {
  it('encrypts and decrypts through base64-serialized blobs', () => {
    const vault = createSafeStorageCredentialVault()
    const encrypted = vault.encrypt('sk-secret')
    expect(encrypted).not.toContain('sk-secret')
    expect(vault.decrypt(encrypted)).toBe('sk-secret')
  })

  it('reports availability from the OS secure storage', () => {
    safeStorageMock.isEncryptionAvailable.mockReturnValueOnce(false)
    expect(createSafeStorageCredentialVault().isAvailable()).toBe(false)
  })

  it('surfaces decryption failures instead of returning garbage', () => {
    safeStorageMock.decryptString.mockImplementationOnce(() => {
      throw new Error('cannot decrypt')
    })
    expect(() => createSafeStorageCredentialVault().decrypt('bm90LXZhbGlk')).toThrow()
  })
})
