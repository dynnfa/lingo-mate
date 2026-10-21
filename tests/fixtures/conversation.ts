import { ConversationModule } from '../../src/core/conversation/conversation-module'
import { languageName } from '../../src/core/prompt/language-name'

type Dependencies = ConstructorParameters<typeof ConversationModule>

// Only a deterministic AgentRuntime test double. Real routing/Prompt behavior is
// covered by Python tests and the real JSONL integration tests, never copied here.
export function createTestConversationModule(
  model: Dependencies[0],
  repository: Dependencies[1],
  ...options: [Dependencies[3]?, Dependencies[4]?, Dependencies[5]?, Dependencies[6]?]
): ConversationModule {
  return new ConversationModule(
    model,
    repository,
    {
      stream(input) {
        return model.streamReply({
          ...input,
          purpose: 'conversation',
          systemPrompt: `Test fixture. Explain in ${languageName(input.outputLanguage)}; examples in ${languageName(input.targetLanguage)}.`
        })
      }
    },
    ...options
  )
}
