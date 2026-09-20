// /explore-phrase 领域错误：code 是跨层传递的安全枚举；原始原因保留为 cause，
// 由会话层映射为事件错误码，不跨进程携带内部信息。

export type ExplorePhraseErrorCode =
  | 'MODEL_NOT_CONFIGURED'
  | 'CREDENTIAL_DECRYPT_FAILED'
  | 'MODEL_ERROR'
  | 'TOOL_CALL_NOT_SUPPORTED'
  | 'INVALID_ANALYSIS'
  | 'TIMEOUT'
  | 'CANCELLED'
  // 历史文件不可读：空文件、损坏 JSON、未知版本或权限错误，不得当作空历史。
  | 'HISTORY_UNREADABLE'
  // 生成期间历史文件被外部编辑：终止提交、保留外部内容。
  | 'HISTORY_MODIFIED'
  // 写入临时文件或原子替换失败：保留旧文件。
  | 'STORAGE_FAILED'
  // 尝试耗尽仍凑不齐 10 个合格短语。
  | 'GENERATION_FAILED'
  // 未补齐回复的历史批次受保护：本次提交不得淘汰它。
  | 'RECOVERY_PENDING'
  | 'UNKNOWN_ERROR'

export class ExplorePhraseError extends Error {
  constructor(
    readonly code: ExplorePhraseErrorCode,
    options?: ErrorOptions
  ) {
    super(`Explore phrase operation failed: ${code}`, options)
    this.name = 'ExplorePhraseError'
  }
}
