import type { Capability, Languages } from './communication-contract'
export interface BusinessRequest {
  requestId: string
  sessionId: string
  userMessageId: string
  assistantMessageId: string
  operation: Capability
  text: string
  languages: Languages
}
export type BusinessResult =
  { status: 'succeeded'; text: string } | { status: 'failed' | 'cancelled' }
export interface BusinessPort {
  // Idempotent, durable conversation creation through the existing conversation module.
  createSession(sessionId: string, title: string): Promise<void>
  execute(request: BusinessRequest, signal: AbortSignal): Promise<BusinessResult>
  // Read only. Undefined means no provable committed result; NEVER execute a retry.
  recover(request: BusinessRequest): Promise<BusinessResult | undefined>
  cancel(requestId: string): void
}
