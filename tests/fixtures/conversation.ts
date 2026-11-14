import type { AgentRuntime } from '../../src/core/agent/agent-runtime'
import { splitConversationCommand } from '../../src/shared/conversation-command'
import { conversationSkillIdSchema } from '../../src/shared/conversation'
import { ConversationModule } from '../../src/core/conversation/conversation-module'
import type { LanguageModel } from '../../src/core/llm/language-model'
import { languageName } from '../../src/core/prompt/language-name'

type Dependencies = ConstructorParameters<typeof ConversationModule>

export function testSystemPrompt(outputLanguage: string, targetLanguage: string): string {
  return `Test fixture. Explain in ${languageName(outputLanguage)}; examples in ${languageName(targetLanguage)}.`
}

// Deterministic stub for tests of the conversation host and persistence.
export const stubConversationRoute: AgentRuntime['routeConversation'] = async ({ mode, text }) => {
  const command = splitConversationCommand(text)
  if (command?.command === 'concept' && (mode === 'desktop' || mode === 'retry'))
    return { kind: 'workflow', workflow: 'concept' }
  const skill = conversationSkillIdSchema.safeParse(command?.command)
  if (
    skill.success &&
    (mode === 'desktop' || (mode === 'channel-sentence' && skill.data === 'sentence'))
  )
    return { kind: 'workflow', workflow: skill.data }
  return { kind: 'reply' }
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
      routeConversation: stubConversationRoute,
      runSentence: async () => {
        throw new Error('Unused sentence runtime')
      },
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
