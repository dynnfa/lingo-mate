import type { BusinessRequest } from './business-port'
import type {
  Capability,
  ConnectionState,
  DeliveryState,
  EncodedPart,
  ExecutionState,
  InboundEvent,
  Languages,
  Receipt,
  Target
} from './communication-contract'
export interface Connection {
  id: string
  adapterId: string
  enabled: boolean
  generation: number
  state: ConnectionState
  config: Record<string, string>
  credentialRef?: string
  error?: string
  reconnectAt?: number
  attempts: number
  cursor?: string
  cursorVersion: number
}
export interface Challenge {
  id: string
  connectionId: string
  digest: string
  expiresAt: number
  attempts: number
  capabilities: Capability[]
  actor?: string
  displayName?: string
  consumed: boolean
}
export interface Binding {
  id: string
  connectionId: string
  externalActorId: string
  principalId: string
  version: number
  capabilities: Capability[]
  revoked: boolean
}
export interface Session {
  id: string
  connectionId: string
  bindingId: string
  bindingVersion: number
  route: Target
  languages: Languages
  sessionId: string
  active: boolean
  touchedAt: number
}
export interface Inbox {
  id: string
  connectionId: string
  eventId: string
  digest: string
  event?: InboundEvent
  receipt: Receipt
  state: ExecutionState
  receivedAt: number
  expiresAt: number
  actorId: string
  scopeKey: string
  control: boolean
  bindingId?: string
  bindingVersion?: number
  languages?: Languages
  sessionRef?: string
  request?: BusinessRequest
  error?: string
}
export interface Confirmation {
  id: string
  bindingId: string
  principalId: string
  bindingVersion: number
  sessionRef: string
  eventId: string
  operation: string
  parameterDigest: string
  digest: string
  expiresAt: number
  consumed: boolean
}
export interface DeliveryPart {
  id: string
  encoded: EncodedPart
  state: DeliveryState
  attempts: number
  nextAt: number
  externalMessageId?: string
}
export interface Delivery {
  id: string
  requestId: string
  connectionId: string
  bindingId: string
  bindingVersion: number
  target: Target
  text: string
  createdAt: number
  expiresAt: number
  encodingVersion?: string
  parts: DeliveryPart[]
  state: DeliveryState
}
export interface CommunicationTables {
  connections: Connection
  challenges: Challenge
  bindings: Binding
  sessions: Session
  inbox: Inbox
  confirmations: Confirmation
  outbox: Delivery
}
export type CommunicationState = {
  [K in keyof CommunicationTables]: Map<string, CommunicationTables[K]>
}
export const TABLES = [
  'connections',
  'challenges',
  'bindings',
  'sessions',
  'inbox',
  'confirmations',
  'outbox'
] as const
export interface CommunicationRepository {
  // Synchronous atomic read/modify/write; callback cannot do network or await business.
  transaction<T>(operation: (state: CommunicationState) => T): T
  read<T>(operation: (state: CommunicationState) => T): T
}
export function activeBinding(
  state: CommunicationState,
  id?: string,
  version?: number
): Binding | undefined {
  const binding = id ? state.bindings.get(id) : undefined
  return binding && !binding.revoked && (version === undefined || binding.version === version)
    ? binding
    : undefined
}
