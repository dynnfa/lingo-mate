import { CommunicationError } from '../../../core/communication/communication-contract'
import { qqAppIdSchema, qqAppSecretSchema } from '../../../shared/communication'
import type { AdapterRegistration } from '../../communication/communication-host'
import type { ErrorLogger } from '../../error-logger'
import { QqAdapter } from './qq-adapter'
import { QqHttp } from './qq-http'

export function createQqRegistration(logger: Pick<ErrorLogger, 'log'>): AdapterRegistration {
  return {
    adapterId: 'qq',
    sessionCursor: true,
    async verifyQqCredential(appId, secret, signal) {
      const http = new QqHttp(appId, secret, signal)
      await http.gateway(await http.authorization())
    },
    create(config, credential, connectionId) {
      if (
        !qqAppIdSchema.safeParse(config.appId).success ||
        !credential ||
        !qqAppSecretSchema.safeParse(credential).success
      )
        throw new CommunicationError('QQ_UNAUTHORIZED')
      return new QqAdapter(config.appId, credential, {
        onDiagnostic: ({ code, ...context }) =>
          logger.log({
            level: 'warn',
            source: 'main',
            module: 'communication',
            operation: 'qq-gateway',
            code,
            message: code,
            context: { connectionId, ...context }
          })
      })
    }
  }
}
