import type { AdapterRegistration } from '../../communication/communication-host'
import { CommunicationError } from '../../../core/communication/communication-contract'
import { TelegramAdapter } from './telegram-adapter'
import { botIdentitySchema } from './telegram-protocol'
import { createTelegramTransport } from './telegram-transport'
export const telegramRegistration: AdapterRegistration = {
  adapterId: 'telegram',
  startAsHelp: true,
  async verifyCredential(token, signal) {
    const result = botIdentitySchema.safeParse(
      await createTelegramTransport(token).call('getMe', {}, signal, 10000)
    )
    if (!result.success) throw new CommunicationError('TELEGRAM_INVALID_RESPONSE')
    return { botId: String(result.data.id), username: result.data.username }
  },
  create(config, credential) {
    if (!credential || !config.botId) throw new CommunicationError('TELEGRAM_UNAUTHORIZED')
    return new TelegramAdapter(createTelegramTransport(credential), config.botId)
  }
}
