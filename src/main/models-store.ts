import { randomUUID } from 'node:crypto'
import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { safeStorage } from 'electron'
import type { CredentialVault, ModelsConfigStore } from '../core/llm/model-config'

// 模型配置保存为用户数据目录下的独立 JSON 记录，带 schemaVersion，
// 不修改语言偏好，也不触碰会话数据库。
export function createFileModelsConfigStore(filePath: string): ModelsConfigStore {
  return {
    read() {
      let raw: string
      try {
        raw = readFileSync(filePath, 'utf8')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
        throw error
      }
      return JSON.parse(raw) as unknown
    },
    // 原子替换：先写同目录临时文件再 rename，写入失败时旧记录保持完整。
    write(record) {
      const tempPath = `${filePath}.${randomUUID()}.tmp`
      writeFileSync(tempPath, `${JSON.stringify(record ?? null, null, 2)}\n`, 'utf8')
      renameSync(tempPath, filePath)
    }
  }
}

// 系统安全存储适配：不可用或仅能提供明文级保护时由调用方返回
// CREDENTIAL_STORAGE_UNAVAILABLE，不降级明文落盘。
export function createSafeStorageCredentialVault(): CredentialVault {
  return {
    isAvailable: () => safeStorage.isEncryptionAvailable(),
    encrypt(plainText: string): string {
      return safeStorage.encryptString(plainText).toString('base64')
    },
    decrypt(serialized: string): string {
      return safeStorage.decryptString(Buffer.from(serialized, 'base64'))
    }
  }
}
