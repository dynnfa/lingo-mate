import { runCommunicationAdapterContract } from '../../../../core/communication/__tests__/adapter-contract'
import { qqHarness } from '../../../../../tests/fixtures/qq'

runCommunicationAdapterContract('QQ C2C WebSocket and passive HTTP replies', qqHarness)
