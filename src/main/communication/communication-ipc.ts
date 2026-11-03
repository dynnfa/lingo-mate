import * as protocol from '../../shared/communication'
import { noInputSchema, type RegisterTrustedHandler } from '../ipc-guard'
import type { CommunicationHost } from './communication-host'
export function registerCommunicationIpc(
  host: CommunicationHost,
  register: RegisterTrustedHandler
): () => void {
  const removers: Array<() => void> = []
  const errors = {
    invalidInputError: () => ({ code: 'INVALID_INPUT' as const }),
    mapError: () => ({ code: 'COMMUNICATION_FAILED' as const }),
    fallbackError: { code: 'COMMUNICATION_FAILED' as const },
    rateLimit: {
      maxRequests: 60,
      windowMs: 60_000,
      error: { code: 'COMMUNICATION_FAILED' as const }
    }
  }
  removers.push(
    register({
      ...errors,
      channel: protocol.COMMUNICATION_CHANNELS.snapshot,
      inputSchema: noInputSchema,
      resultSchema: protocol.communicationSnapshotResultSchema,
      handler: () => ({ status: 'ok' as const, snapshot: host.snapshot() })
    })
  )
  removers.push(
    register({
      ...errors,
      channel: protocol.COMMUNICATION_CHANNELS.start,
      inputSchema: protocol.connectionInputSchema,
      resultSchema: protocol.communicationActionResultSchema,
      handler: async (i) => {
        await host.service.start(i.connectionId)
        return { status: 'ok' as const }
      }
    })
  )
  removers.push(
    register({
      ...errors,
      channel: protocol.COMMUNICATION_CHANNELS.stop,
      inputSchema: protocol.connectionInputSchema,
      resultSchema: protocol.communicationActionResultSchema,
      handler: async (i) => {
        await host.service.stop(i.connectionId)
        return { status: 'ok' as const }
      }
    })
  )
  removers.push(
    register({
      ...errors,
      channel: protocol.COMMUNICATION_CHANNELS.createChallenge,
      inputSchema: protocol.challengeInputSchema,
      resultSchema: protocol.challengeResultSchema,
      handler: (i) => ({
        status: 'ok' as const,
        ...host.service.createChallenge(i.connectionId, i.capabilities)
      })
    })
  )
  removers.push(
    register({
      ...errors,
      channel: protocol.COMMUNICATION_CHANNELS.confirmBinding,
      inputSchema: protocol.challengeIdInputSchema,
      resultSchema: protocol.communicationActionResultSchema,
      handler: (i) => {
        host.service.confirmBinding(i.challengeId)
        return { status: 'ok' as const }
      }
    })
  )
  removers.push(
    register({
      ...errors,
      channel: protocol.COMMUNICATION_CHANNELS.revokeBinding,
      inputSchema: protocol.bindingInputSchema,
      resultSchema: protocol.communicationActionResultSchema,
      handler: (i) => {
        host.service.revokeBinding(i.bindingId)
        return { status: 'ok' as const }
      }
    })
  )
  removers.push(
    register({
      ...errors,
      channel: protocol.COMMUNICATION_CHANNELS.cancelRequest,
      inputSchema: protocol.channelCancelInputSchema,
      resultSchema: protocol.communicationActionResultSchema,
      handler: (i) => {
        host.service.cancelRequest(i.bindingId, i.requestId)
        return { status: 'ok' as const }
      }
    })
  )
  removers.push(
    register({
      ...errors,
      channel: protocol.COMMUNICATION_CHANNELS.resolveDelivery,
      inputSchema: protocol.deliveryInputSchema,
      resultSchema: protocol.communicationActionResultSchema,
      handler: (i) => {
        host.service.resolveDelivery(i.deliveryId, i.action, i.acknowledgeDuplicate)
        return { status: 'ok' as const }
      }
    })
  )
  removers.push(
    register({
      ...errors,
      channel: protocol.COMMUNICATION_CHANNELS.setCredential,
      inputSchema: protocol.credentialInputSchema,
      resultSchema: protocol.communicationActionResultSchema,
      handler: async (i) => {
        await host.setCredential(i.connectionId, i.credential)
        return { status: 'ok' as const }
      }
    })
  )
  return () => removers.forEach((remove) => remove())
}
