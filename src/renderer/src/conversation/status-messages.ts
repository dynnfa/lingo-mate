import type { TFunction } from 'i18next'
import type { ConversationRequestError, GenerationEventError } from '../../../shared/conversation'
import type { ConversationStatus, StatusOperation } from './conversation-state'

type StatusTFunction = TFunction<['common', 'conversation', 'errors']>

// 穷尽的显式映射，不使用任意字符串断言绕过 key 校验。
const IPC_FAILURE_KEYS: Record<StatusOperation, IpcFailureKey> = {
  load: 'errors:ipc.load',
  list: 'errors:ipc.list',
  create: 'errors:ipc.create',
  send: 'errors:ipc.send',
  runSkill: 'errors:ipc.runSkill',
  cancel: 'errors:ipc.cancel',
  retry: 'errors:ipc.retry'
}

type IpcFailureKey =
  | 'errors:ipc.load'
  | 'errors:ipc.list'
  | 'errors:ipc.create'
  | 'errors:ipc.send'
  | 'errors:ipc.runSkill'
  | 'errors:ipc.cancel'
  | 'errors:ipc.retry'

// 技能相关状态的文案 key：显式枚举，保持类型检查覆盖。
type SkillStatusKeys = {
  analyzing:
    | 'conversation:status.analyzingVocabulary'
    | 'conversation:status.analyzingPhrase'
    | 'conversation:status.analyzingSynonym'
    | 'conversation:status.generatingExplorePhrase'
  committing:
    | 'conversation:status.committingVocabulary'
    | 'conversation:status.committingPhrase'
    | 'conversation:status.committingSynonym'
    | 'conversation:status.committingExplorePhrase'
  descriptionFailed:
    | 'conversation:status.descriptionFailedVocabulary'
    | 'conversation:status.descriptionFailedPhrase'
    | 'conversation:status.descriptionFailedSynonym'
    | 'conversation:status.descriptionFailedExplorePhrase'
  descriptionCancelled:
    | 'conversation:status.descriptionCancelledVocabulary'
    | 'conversation:status.descriptionCancelledPhrase'
    | 'conversation:status.descriptionCancelledSynonym'
    | 'conversation:status.descriptionCancelledExplorePhrase'
}

const skillKeys = (
  skillId: 'vocabulary' | 'phrase' | 'synonym' | 'explore-phrase' | undefined
): SkillStatusKeys =>
  skillId === 'synonym'
    ? {
        analyzing: 'conversation:status.analyzingSynonym',
        committing: 'conversation:status.committingSynonym',
        descriptionFailed: 'conversation:status.descriptionFailedSynonym',
        descriptionCancelled: 'conversation:status.descriptionCancelledSynonym'
      }
    : skillId === 'phrase'
      ? {
          analyzing: 'conversation:status.analyzingPhrase',
          committing: 'conversation:status.committingPhrase',
          descriptionFailed: 'conversation:status.descriptionFailedPhrase',
          descriptionCancelled: 'conversation:status.descriptionCancelledPhrase'
        }
      : skillId === 'explore-phrase'
        ? {
            // 阶段文案表达“生成短语”，避免误用“收录/收藏成功”。
            analyzing: 'conversation:status.generatingExplorePhrase',
            committing: 'conversation:status.committingExplorePhrase',
            descriptionFailed: 'conversation:status.descriptionFailedExplorePhrase',
            descriptionCancelled: 'conversation:status.descriptionCancelledExplorePhrase'
          }
        : {
            analyzing: 'conversation:status.analyzingVocabulary',
            committing: 'conversation:status.committingVocabulary',
            descriptionFailed: 'conversation:status.descriptionFailedVocabulary',
            descriptionCancelled: 'conversation:status.descriptionCancelledVocabulary'
          }

export function translateConversationStatus(
  t: StatusTFunction,
  status: ConversationStatus
): string {
  switch (status.kind) {
    case 'restoring':
      return t('conversation:status.restoring')
    case 'switching':
      return t('conversation:status.switching')
    case 'creating':
      return t('conversation:status.creating')
    case 'ready':
      return t('conversation:status.ready')
    case 'generatingTitle':
      return t('conversation:status.generatingTitle')
    case 'generating':
      return t('conversation:status.generating')
    case 'skillPhase': {
      const keys = skillKeys(status.skillId)
      if (status.phase === 'analyzing') return t(keys.analyzing)
      if (status.phase === 'committing') return t(keys.committing)
      return t('conversation:status.summarizing')
    }
    case 'completed':
      return t('conversation:status.completed')
    case 'skillDescriptionFailed': {
      const keys = skillKeys(status.skillId)
      return status.cancelled ? t(keys.descriptionCancelled) : t(keys.descriptionFailed)
    }
    case 'cancelled':
      return t('conversation:status.cancelled')
    case 'protocolError':
      return t('conversation:status.protocolError')
    case 'generationError':
      return translateGenerationError(t, status.error)
    case 'requestError':
      return translateRequestError(t, status.error)
    case 'ipcError':
      return t(IPC_FAILURE_KEYS[status.operation])
  }
}

function translateRequestError(t: StatusTFunction, error: ConversationRequestError): string {
  switch (error.code) {
    case 'NOT_FOUND':
      return error.resource === 'conversation'
        ? t('errors:notFound.conversation')
        : t('errors:notFound.message')
    case 'CONVERSATION_BUSY':
      return t('errors:conversationBusy')
    case 'REQUEST_BUSY':
      return t('errors:requestBusy')
    case 'RETRY_NOT_ALLOWED':
      return t('errors:retryNotAllowed')
    case 'REQUEST_NOT_FOUND':
      return t('errors:requestNotFound')
    case 'INVALID_INPUT':
      return t('errors:invalidInput')
    case 'UNTRUSTED_SOURCE':
      return t('errors:untrustedSource')
    case 'PERSISTENCE_ERROR':
      return t('errors:persistence')
    case 'MODEL_ERROR':
      return t('errors:generation.model')
    case 'MODEL_NOT_CONFIGURED':
      return t('errors:generation.modelNotConfigured')
    case 'CREDENTIAL_DECRYPT_FAILED':
      return t('errors:credentialDecryptFailed')
    case 'CANCELLED':
      return t('conversation:status.cancelled')
    case 'UNKNOWN_ERROR':
      return t('errors:unknown')
  }
}

function translateGenerationError(t: StatusTFunction, error: GenerationEventError): string {
  switch (error.code) {
    case 'MODEL_ERROR':
      return t('errors:generation.model')
    case 'CREDENTIAL_DECRYPT_FAILED':
      return t('errors:credentialDecryptFailed')
    case 'MODEL_NOT_CONFIGURED':
      return t('errors:generation.modelNotConfigured')
    case 'TOOL_CALL_NOT_SUPPORTED':
      return t('errors:generation.toolCallNotSupported')
    case 'PERSISTENCE_ERROR':
      return t('errors:generation.persistence')
    case 'UNKNOWN_ERROR':
      return t('errors:generation.unknown')
  }
}
