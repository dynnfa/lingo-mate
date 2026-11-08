import { ipcRenderer } from 'electron'
import * as p from '../shared/communication'
export function createCommunicationApi(): p.CommunicationApi {
  const c = p.COMMUNICATION_CHANNELS
  return {
    async createQqConnection(input) {
      return p.createConnectionResultSchema.parse(
        await ipcRenderer.invoke(c.createQqConnection, p.createQqInputSchema.parse(input))
      )
    },
    async replaceQqSecret(input) {
      return p.communicationActionResultSchema.parse(
        await ipcRenderer.invoke(c.replaceQqSecret, p.replaceQqSecretInputSchema.parse(input))
      )
    },
    async createTelegramConnection(input) {
      return p.createConnectionResultSchema.parse(
        await ipcRenderer.invoke(
          c.createTelegramConnection,
          p.createTelegramInputSchema.parse(input)
        )
      )
    },
    async deleteConnection(input) {
      return p.communicationActionResultSchema.parse(
        await ipcRenderer.invoke(c.deleteConnection, p.connectionInputSchema.parse(input))
      )
    },
    async snapshot() {
      return p.communicationSnapshotResultSchema.parse(await ipcRenderer.invoke(c.snapshot))
    },
    async testConnection(input) {
      return p.communicationActionResultSchema.parse(
        await ipcRenderer.invoke(c.testConnection, p.connectionInputSchema.parse(input))
      )
    },
    async start(input) {
      return p.communicationActionResultSchema.parse(
        await ipcRenderer.invoke(c.start, p.connectionInputSchema.parse(input))
      )
    },
    async stop(input) {
      return p.communicationActionResultSchema.parse(
        await ipcRenderer.invoke(c.stop, p.connectionInputSchema.parse(input))
      )
    },
    async createChallenge(input) {
      return p.challengeResultSchema.parse(
        await ipcRenderer.invoke(c.createChallenge, p.challengeInputSchema.parse(input))
      )
    },
    async confirmBinding(input) {
      return p.communicationActionResultSchema.parse(
        await ipcRenderer.invoke(c.confirmBinding, p.challengeIdInputSchema.parse(input))
      )
    },
    async revokeBinding(input) {
      return p.communicationActionResultSchema.parse(
        await ipcRenderer.invoke(c.revokeBinding, p.bindingInputSchema.parse(input))
      )
    },
    async cancelRequest(input) {
      return p.communicationActionResultSchema.parse(
        await ipcRenderer.invoke(c.cancelRequest, p.channelCancelInputSchema.parse(input))
      )
    },
    async resolveDelivery(input) {
      return p.communicationActionResultSchema.parse(
        await ipcRenderer.invoke(c.resolveDelivery, p.deliveryInputSchema.parse(input))
      )
    },
    async setCredential(input) {
      return p.communicationActionResultSchema.parse(
        await ipcRenderer.invoke(c.setCredential, p.credentialInputSchema.parse(input))
      )
    }
  }
}
