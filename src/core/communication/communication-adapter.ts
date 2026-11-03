import type {
  AdapterCapabilities,
  EncodedPart,
  Receipt,
  RejectedEnvelope,
  SendResult,
  Target
} from './communication-contract'
export interface AdapterContext {
  signal: AbortSignal
  cursor?: string
  receive(event: unknown, cursor?: string): Promise<Receipt>
  receiveRejected(envelope: RejectedEnvelope, cursor?: string): Promise<Receipt>
  disconnected(retryable: boolean, code?: string, retryAfterMs?: number): void
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
  constructor(
    readonly retryable: boolean,
    readonly code = 'CONNECTION_FAILED',
    readonly retryAfterMs?: number
  ) {
    super('ADAPTER_CONNECTION_FAILED')
  }
}
