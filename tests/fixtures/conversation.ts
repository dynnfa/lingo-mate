import { ConversationModule } from '../../src/core/conversation/conversation-module'
import { languageName } from '../../src/core/prompt/language-name'

type Dependencies = ConstructorParameters<typeof ConversationModule>

export function testSystemPrompt(outputLanguage: string, targetLanguage: string): string {
  return `Test fixture. Explain in ${languageName(outputLanguage)}; examples in ${languageName(targetLanguage)}.`
}

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
      runVocabulary: async () => {
        throw new Error('Unused vocabulary runtime')
      },
      stream: ({ messages, signal, outputLanguage, targetLanguage }) =>
        model.streamReply({
          messages,
          signal,
          purpose: 'conversation',
          systemPrompt: testSystemPrompt(outputLanguage, targetLanguage)
        })
    },
    ...options
  )
}
