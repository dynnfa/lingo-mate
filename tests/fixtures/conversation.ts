import { ConversationModule } from '../../src/core/conversation/conversation-module'
import type { LanguageModel } from '../../src/core/llm/language-model'
import { languageName } from '../../src/core/prompt/language-name'

type Dependencies = ConstructorParameters<typeof ConversationModule>

export function testSystemPrompt(outputLanguage: string, targetLanguage: string): string {
  return `Test fixture. Explain in ${languageName(outputLanguage)}; examples in ${languageName(targetLanguage)}.`
}

// Only a deterministic AgentRuntime test double. Real routing/Prompt behavior is
// covered by Python tests and the real JSONL integration tests, never copied here.
export function createTestConversationModule(
  model: LanguageModel,
  repository: Dependencies[0],
  ...options: [Dependencies[2]?, Dependencies[3]?, Dependencies[4]?, Dependencies[5]?]
): ConversationModule {
  return new ConversationModule(
    repository,
    {
      runTts: async () => {
        throw new Error('Unexpected speech task')
      },
      runVocabularyPractice: async () => {
        throw new Error('Unused vocabulary practice runtime')
      },
      runSentencePractice: async () => {
        throw new Error('Unused sentence practice runtime')
      },
      runPhrase: async () => {
        throw new Error('Unused phrase runtime')
      },
      runExploreVocabulary: async () => {
        throw new Error('Unused vocabulary exploration runtime')
      },
      runExplorePhrase: async () => {
        throw new Error('Unused exploration runtime')
      },
      runSynonym: async () => {
        throw new Error('Unused synonym runtime')
      },
      runVocabulary: async () => {
        throw new Error('Unused vocabulary runtime')
      },
      stream: ({ task, messages, signal, outputLanguage, targetLanguage }) =>
        model.streamReply({
          messages,
          signal,
          purpose: task === 'conversation-title' ? 'conversation-title' : 'conversation',
          systemPrompt:
            task === 'conversation-title'
              ? `Test fixture. Write the title in ${languageName(outputLanguage)}.`
              : testSystemPrompt(outputLanguage, targetLanguage)
        })
    },
    ...options
  )
}
