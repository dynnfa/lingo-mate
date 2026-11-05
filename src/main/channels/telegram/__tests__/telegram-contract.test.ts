import { runCommunicationAdapterContract } from '../../../../core/communication/__tests__/adapter-contract'
import { telegramHarness } from '../../../../../tests/fixtures/telegram'
runCommunicationAdapterContract('Telegram raw Bot API polling', telegramHarness)
