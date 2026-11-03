import type { AdapterContext, CommunicationAdapter } from '../communication-adapter'
import type { EncodedPart, Receipt, SendResult, Target } from '../communication-contract'
export class TestAdapter implements CommunicationAdapter {
  readonly capabilities
  context?: AdapterContext
  sent: EncodedPart[] = []
  outcomes: SendResult[] = []
  constructor(interactive: boolean) {
    this.capabilities = {
      edit: interactive,
      interactions: interactive,
      attachments: false,
      maxTextLength: 32,
      encodingVersion: 'test-v1'
    }
  }
  async start(context: AdapterContext): Promise<void> {
    this.context = context
  }
  async stop(): Promise<void> {
    /* stale callbacks deliberately retained for generation tests */
  }
  receive(event: unknown, cursor?: string): Promise<Receipt> {
    if (!this.context) throw new Error('not started')
    return this.context.receive(event, cursor)
  }
  encode(text: string): EncodedPart[] {
    const parts: EncodedPart[] = []
    let current = ''
    for (const character of text) {
      if ((current + character).length > this.capabilities.maxTextLength) {
        parts.push({ text: current, format: 'plain' })
        current = ''
      }
      current += character
    }
    if (current) parts.push({ text: current, format: 'plain' })
    return parts
  }
  async edit(_target: Target, externalMessageId: string, part: EncodedPart): Promise<SendResult> {
    if (!this.capabilities.edit) return { status: 'failed' }
    this.sent.push(part)
    return { status: 'sent', externalMessageId }
  }
  async send(_target: Target, part: EncodedPart): Promise<SendResult> {
    const result = this.outcomes.shift() ?? {
      status: 'sent',
      externalMessageId: `sent-${this.sent.length}`
    }
    if (result.status === 'sent') this.sent.push(part)
    return result
  }
}
