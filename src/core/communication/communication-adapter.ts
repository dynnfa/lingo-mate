import type {
  AdapterCapabilities,
  EncodedPart,
  Receipt,
  Languages,
  SendIdentity,
  RejectedEnvelope,
  SendResult,
  Target
} from './communication-contract'
export interface AdapterContext {
  signal: AbortSignal
  cursor?: string
  discardCursor?(): boolean
  receive(event: unknown, cursor?: string): Promise<Receipt>
  receiveRejected(envelope: RejectedEnvelope | undefined, cursor?: string): Promise<Receipt>
  disconnected(retryable: boolean, code?: string, retryAfterMs?: number): void
}
// start is ONE connection attempt. No hidden send retries. encode is pure.
export interface CommunicationAdapter {
  readonly capabilities: AdapterCapabilities
  start(context: AdapterContext): Promise<void>
  stop(): Promise<void>
  encode(text: string, language?: Languages['uiLanguage']): EncodedPart[]
  edit?(
    target: Target,
    externalMessageId: string,
    part: EncodedPart,
    signal: AbortSignal
  ): Promise<SendResult>
  send(
    target: Target,
    part: EncodedPart,
    identity: SendIdentity,
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
