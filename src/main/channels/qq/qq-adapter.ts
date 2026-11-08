import type {
  AdapterContext,
  CommunicationAdapter
} from '../../../core/communication/communication-adapter'
import {
  replyContextSchema,
  type AdapterCapabilities,
  type EncodedPart,
  type Languages,
  type SendIdentity,
  type SendResult,
  type Target
} from '../../../core/communication/communication-contract'
import { encodeQqText } from './qq-encoding'
import {
  openQqSocket,
  QqGateway,
  type QqGatewayDiagnostic,
  type QqSocketFactory
} from './qq-gateway'
import { QqHttp } from './qq-http'
import {
  QQ_MAX_PARTS,
  QQ_PART_UNITS,
  parseJson,
  qqCursor,
  qqMessageId,
  qqOpenId
} from './qq-protocol'

type QqAdapterOptions = {
  fetch?: typeof fetch
  open?: QqSocketFactory
  onDiagnostic?: (entry: QqGatewayDiagnostic) => void
}

export class QqAdapter implements CommunicationAdapter {
  readonly capabilities = {
    edit: false,
    interactions: false,
    attachments: false,
    maxTextLength: QQ_PART_UNITS,
    encodingVersion: 'qq-c2c-plain-v1',
    requiresReplyContext: true
  } satisfies AdapterCapabilities
  private controller?: AbortController
  private gateway?: QqGateway
  private http?: QqHttp

  constructor(
    private readonly appId: string,
    private readonly secret: string,
    private readonly options: QqAdapterOptions = {}
  ) {}

  async start(context: AdapterContext): Promise<void> {
    const controller = new AbortController()
    this.controller = controller
    const lifetime = AbortSignal.any([context.signal, controller.signal])
    const http = new QqHttp(this.appId, this.secret, lifetime, this.options.fetch)
    this.http = http
    const abort = (): void => controller.abort()
    context.signal.addEventListener('abort', abort, { once: true, signal: controller.signal })
    try {
      const authorization = await http.authorization()
      const cursor = qqCursor.safeParse(parseJson(context.cursor))
      const resume = cursor.success && cursor.data.appId === this.appId ? cursor.data : undefined
      const url = await http.gateway(authorization, resume !== undefined)
      lifetime.throwIfAborted()
      this.gateway = new QqGateway(
        context,
        controller,
        this.appId,
        authorization,
        this.options.open ?? openQqSocket,
        resume,
        this.options.onDiagnostic
      )
      await this.gateway.start(url)
    } catch (error) {
      controller.abort()
      throw error
    }
  }

  async stop(): Promise<void> {
    this.controller?.abort()
    this.gateway = undefined
    this.http = undefined
    this.controller = undefined
  }

  encode(text: string, language?: Languages['uiLanguage']): EncodedPart[] {
    return encodeQqText(text, language)
  }

  async send(
    target: Target,
    part: EncodedPart,
    identity: SendIdentity,
    signal: AbortSignal
  ): Promise<SendResult> {
    const reply = replyContextSchema.safeParse(identity.reply)
    const { sequence } = identity
    if (
      !reply.success ||
      !qqMessageId.safeParse(reply.data.externalMessageId).success ||
      reply.data.expiresAt <= Date.now() ||
      !qqOpenId.safeParse(target.externalActorId).success ||
      target.externalActorId !== target.externalConversationId ||
      target.externalThreadId !== undefined ||
      !sequence ||
      !Number.isInteger(sequence) ||
      sequence < 1 ||
      sequence > QQ_MAX_PARTS ||
      part.format !== 'plain' ||
      part.payload !== undefined ||
      !part.text.length ||
      part.text.length > QQ_PART_UNITS ||
      !part.text.isWellFormed()
    ) {
      return { status: 'failed', terminal: true }
    }
    if (!this.gateway?.online || !this.http || signal.aborted) return { status: 'retry' }
    return this.http.send(
      target.externalActorId,
      {
        content: part.text,
        msg_type: 0,
        msg_id: reply.data.externalMessageId,
        msg_seq: sequence
      },
      reply.data.expiresAt,
      signal
    )
  }
}
