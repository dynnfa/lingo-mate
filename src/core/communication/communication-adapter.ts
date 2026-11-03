import type {
  AdapterCapabilities,
  EncodedPart,
  Receipt,
  SendResult,
  Target
} from './communication-contract'
export interface AdapterContext {
  signal: AbortSignal
  cursor?: string
  receive(event: unknown, cursor?: string): Promise<Receipt>
  disconnected(retryable: boolean): void
}
// start is ONE connection attempt. No hidden send retries. encode is pure.
export interface CommunicationAdapter {
  readonly capabilities: AdapterCapabilities
  start(context: AdapterContext): Promise<void>
  stop(): Promise<void>
  encode(text: string): EncodedPart[]
  edit?(
    target: Target,
    externalMessageId: string,
    part: EncodedPart,
    signal: AbortSignal
  ): Promise<SendResult>
  send(
    target: Target,
    part: EncodedPart,
    identity: { deliveryId: string; partId: string },
    signal: AbortSignal
  ): Promise<SendResult>
}

// One failed connection attempt, classified by the transport without exposing SDK errors.
export class AdapterConnectionError extends Error {
  constructor(readonly retryable: boolean) {
    super('ADAPTER_CONNECTION_FAILED')
  }
}
