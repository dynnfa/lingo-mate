import { runCommunicationAdapterContract } from './adapter-contract'
import { TestAdapter } from './test-adapter'
for (const interactive of [false, true]) {
  runCommunicationAdapterContract(
    interactive ? 'editing and interaction' : 'final text only',
    () => {
      const adapter = new TestAdapter(interactive)
      return {
        adapter,
        inject: (event, cursor) => adapter.receive(event, cursor),
        sentTexts: () => adapter.sent.map((part) => part.text)
      }
    }
  )
}
