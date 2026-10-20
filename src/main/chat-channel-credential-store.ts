import { randomUUID } from 'node:crypto'
import { readFileSync, renameSync, writeFileSync } from 'node:fs'

// 聊天平台凭据存储：Token 加密后保存为用户数据目录下的独立 JSON，
// 不进数据库、不回读明文；写入失败时旧记录保持完整。

export interface ChatChannelCredentialRecord {
  schemaVersion: 1
  connectionId: string
  encryptedToken: string
}

export interface ChatChannelCredentialStore {
  read(): ChatChannelCredentialRecord | undefined
  write(record: ChatChannelCredentialRecord): void
  clear(): void
}

export function createFileChatChannelCredentialStore(filePath: string): ChatChannelCredentialStore {
  return {
    read() {
      let raw: string
      try {
        raw = readFileSync(filePath, 'utf8')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
        throw error
      }
      const parsed = JSON.parse(raw) as ChatChannelCredentialRecord | null
      return parsed === null ? undefined : parsed
    },
    // 原子替换：先写同目录临时文件再 rename。
    write(record) {
      const tempPath = `${filePath}.${randomUUID()}.tmp`
      writeFileSync(tempPath, `${JSON.stringify(record, null, 2)}\n`, 'utf8')
      renameSync(tempPath, filePath)
    },
    clear() {
      writeFileSync(filePath, `${JSON.stringify(null, null, 2)}\n`, 'utf8')
    }
  }
}
