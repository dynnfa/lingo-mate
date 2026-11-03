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
