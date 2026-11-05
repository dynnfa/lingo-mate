import { CommunicationError } from '../../../core/communication/communication-contract'
import { qqAppIdSchema, qqAppSecretSchema } from '../../../shared/communication'
import type { AdapterRegistration } from '../../communication/communication-host'
import { QqAdapter } from './qq-adapter'
import { QqHttp } from './qq-http'

export const qqRegistration: AdapterRegistration = {
  adapterId: 'qq',
  sessionCursor: true,
  async verifyQqCredential(appId, secret, signal) {
    const http = new QqHttp(appId, secret, signal)
    await http.gateway(await http.authorization())
  },
  create(config, credential) {
    if (
      !qqAppIdSchema.safeParse(config.appId).success ||
      !credential ||
      !qqAppSecretSchema.safeParse(credential).success
    )
      throw new CommunicationError('QQ_UNAUTHORIZED')
    return new QqAdapter(config.appId, credential)
  }
}
