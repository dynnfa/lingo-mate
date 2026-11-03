import type { Languages } from './communication-contract'
export interface CommunicationEnvironment {
  schedule?(callback: () => void, ms: number): () => void
  now(): number
  id(): string
  secret(): string
  digest(value: string): string
  languages(): Languages
  // Metadata only. No event bodies, transport cursors, tokens, URLs or raw SDK errors.
  diagnostics(entry: {
    code: string
    connectionId?: string
    requestId?: string
    deliveryId?: string
  }): void
}
