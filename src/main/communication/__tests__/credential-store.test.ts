import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { expect, it, vi } from 'vitest'
import { createCommunicationCredentialStore } from '../credential-store'
const mocks = vi.hoisted(() => ({ available: true, backend: 'keychain' }))
vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => mocks.available,
    getSelectedStorageBackend: () => mocks.backend,
    encryptString: (value: string) => Buffer.from(value.split('').reverse().join('')),
    decryptString: (value: Buffer) => value.toString().split('').reverse().join('')
  }
}))
it('stores only encrypted bytes, reads only via Main, rejects unsafe references and fails closed', () => {
  const directory = mkdtempSync(join(tmpdir(), 'lingo-credential-test-'))
  try {
    const store = createCommunicationCredentialStore(directory)
    const reference = store.write('SECRET_PLAINTEXT')
    expect(readFileSync(join(directory, reference)).toString()).not.toContain('SECRET_PLAINTEXT')
    expect(store.read(reference)).toBe('SECRET_PLAINTEXT')
    expect(() => store.read('../arbitrary')).toThrow('INVALID_CREDENTIAL_REFERENCE')
    mocks.available = false
    expect(() => store.write('secret')).toThrow('CREDENTIAL_STORAGE_UNAVAILABLE')
    mocks.available = true
    store.remove(reference)
    store.remove(reference)
  } finally {
    mocks.available = true
    rmSync(directory, { recursive: true, force: true })
  }
})
it('prunes only unreferenced credential files, preserving referenced files and unrelated names', async () => {
  const { existsSync, writeFileSync } = await import('node:fs')
  const directory = mkdtempSync(join(tmpdir(), 'lingo-credential-prune-'))
  try {
    const store = createCommunicationCredentialStore(directory)
    const live = store.write('live')
    const orphan = store.write('orphan')
    writeFileSync(join(directory, 'unrelated'), 'keep')
    store.prune!([live])
    expect(store.read(live)).toBe('live')
    expect(existsSync(join(directory, orphan))).toBe(false)
    expect(existsSync(join(directory, 'unrelated'))).toBe(true)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
