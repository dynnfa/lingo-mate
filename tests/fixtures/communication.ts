import type { CommunicationApi } from '../../src/shared/communication'
export function emptyCommunicationApi(): CommunicationApi {
  const ok = async (): Promise<{ status: 'ok' }> => ({ status: 'ok' })
  return {
    snapshot: async () => ({
      status: 'ok',
      snapshot: { connections: [], challenges: [], bindings: [], requests: [], deliveries: [] }
    }),
    createTelegramConnection: async () => ({
      status: 'error',
      error: { code: 'COMMUNICATION_FAILED' }
    }),
    deleteConnection: ok,
    start: ok,
    stop: ok,
    confirmBinding: ok,
    revokeBinding: ok,
    cancelRequest: ok,
    resolveDelivery: ok,
    setCredential: ok,
    createChallenge: async () => ({ status: 'error', error: { code: 'COMMUNICATION_FAILED' } })
  }
}
