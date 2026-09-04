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
  cancel: 'errors:ipc.cancel',
  retry: 'errors:ipc.retry'
}

type IpcFailureKey =
  | 'errors:ipc.load'
  | 'errors:ipc.list'
  | 'errors:ipc.create'
  | 'errors:ipc.send'
  | 'errors:ipc.cancel'
  | 'errors:ipc.retry'

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
    case 'generating':
      return t('conversation:status.generating')
    case 'completed':
      return t('conversation:status.completed')
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
    case 'PERSISTENCE_ERROR':
      return t('errors:persistence')
    case 'UNKNOWN_ERROR':
      return t('errors:unknown')
  }
}

function translateGenerationError(t: StatusTFunction, error: GenerationEventError): string {
  switch (error.code) {
    case 'MODEL_ERROR':
      return t('errors:generation.model')
    case 'PERSISTENCE_ERROR':
      return t('errors:generation.persistence')
    case 'UNKNOWN_ERROR':
      return t('errors:generation.unknown')
  }
}
