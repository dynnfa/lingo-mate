import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { safeStorage } from 'electron'
import { CommunicationError } from '../../core/communication/communication-contract'
export interface CommunicationCredentialStore {
  write(secret: string): string
  read(reference: string): string
  remove(reference: string): void
}
// Main only. Reference names are generated locally; never use platform input as a path.
export function createCommunicationCredentialStore(
  directory: string
): CommunicationCredentialStore {
  const path = (reference: string): string => {
    if (!/^[0-9a-f-]{36}$/u.test(reference))
      throw new CommunicationError('INVALID_CREDENTIAL_REFERENCE')
    return join(directory, reference)
  }
  const available = (): void => {
    if (
      !safeStorage.isEncryptionAvailable() ||
      (process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text')
    )
      throw new CommunicationError('CREDENTIAL_STORAGE_UNAVAILABLE')
  }
  return {
    write(secret) {
      available()
      const reference = randomUUID(),
        file = path(reference),
        temporary = `${file}.tmp`
      mkdirSync(directory, { recursive: true, mode: 0o700 })
      writeFileSync(temporary, safeStorage.encryptString(secret), { mode: 0o600 })
      renameSync(temporary, file)
      return reference
    },
    read(reference) {
      available()
      return safeStorage.decryptString(readFileSync(path(reference)))
    },
    remove(reference) {
      try {
        unlinkSync(path(reference))
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
  }
}
