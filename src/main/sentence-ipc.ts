import type { RegisterTrustedHandler } from './ipc-guard'
import type { SentenceManagementService } from '../core/learning/sentence/sentence-management'
import { SentenceError } from '../core/learning/sentence/sentence-repository'
import {
  SENTENCE_CHANNELS,
  listSentenceInputSchema,
  listSentenceResultSchema,
  deleteSentenceInputSchema,
  deleteSentenceResultSchema,
  type SentenceManagementErrorCode
} from '../shared/sentence'
export function registerSentenceIpc(
  service: SentenceManagementService,
  register: RegisterTrustedHandler
): () => void {
  const mapError = (error: unknown): { code: SentenceManagementErrorCode } => ({
    code:
      error instanceof SentenceError && error.code === 'STORAGE_FAILED'
        ? 'STORAGE_FAILED'
        : 'UNKNOWN_ERROR'
  })
  const removeList = register({
    channel: SENTENCE_CHANNELS.list,
    inputSchema: listSentenceInputSchema,
    resultSchema: listSentenceResultSchema,
    invalidInputError: () => ({ code: 'INVALID_INPUT' as const }),
    mapError,
    fallbackError: { code: 'UNKNOWN_ERROR' },
    handler: (input) => ({ status: 'ok' as const, ...service.list(input) })
  })
  const removeDelete = register({
    channel: SENTENCE_CHANNELS.delete,
    inputSchema: deleteSentenceInputSchema,
    resultSchema: deleteSentenceResultSchema,
    invalidInputError: () => ({ code: 'INVALID_INPUT' as const }),
    mapError,
    fallbackError: { code: 'UNKNOWN_ERROR' },
    handler: (input) => ({ status: 'ok' as const, ...service.delete(input) })
  })
  return () => {
    removeList()
    removeDelete()
  }
}
