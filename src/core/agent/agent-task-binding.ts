import type { AgentSnapshot } from './agent-protocol'
import {
  AgentRuntimeError,
  type TtsHostOperations,
  type VocabularyPracticeHostOperations,
  type SentencePracticeHostOperations,
  type VocabularyHostOperations,
  type PhraseHostOperations,
  type SynonymHostOperations,
  type ExplorePhraseHostOperations,
  type ExploreVocabularyHostOperations
} from './agent-runtime'
import type { AgentTaskBinding, AgentTestOperations, ResolveAgentModel } from './agent-task'
import { getAgentTaskPolicy } from './agent-task-policy'
import { TtsTask } from './tasks/tts-task'
import { VocabularyPracticeTask } from './tasks/vocabulary-practice-task'
import { SentencePracticeTask } from './tasks/sentence-practice-task'
import { VocabularyTask } from './tasks/vocabulary-task'
import { PhraseTask } from './tasks/phrase-task'
import { SynonymTask } from './tasks/synonym-task'
import { ExplorePhraseTask } from './tasks/explore-phrase-task'
import { ExploreVocabularyTask } from './tasks/explore-vocabulary-task'
import { ConversationTask } from './tasks/conversation-task'
import { ToolLoopTask } from './tasks/tool-loop-task'

export type AgentTaskBindingInput =
  | { task: 'tts'; host: TtsHostOperations }
  | { task: 'vocabulary-practice-review'; host: VocabularyPracticeHostOperations }
  | {
      task: 'sentence-practice-hints' | 'sentence-practice-review'
      host: SentencePracticeHostOperations
    }
  | { task: 'vocabulary'; host: VocabularyHostOperations }
  | { task: 'phrase'; host: PhraseHostOperations }
  | { task: 'synonym'; host: SynonymHostOperations }
  | { task: 'explore-phrase'; host: ExplorePhraseHostOperations }
  | { task: 'explore-vocabulary'; host: ExploreVocabularyHostOperations }
  | { task: 'conversation' | 'conversation-title'; resolveModel: ResolveAgentModel }
  | { task: 'tool-loop'; operations: AgentTestOperations }

export type BatchTaskBindingInput = Exclude<
  AgentTaskBindingInput,
  { task: 'conversation' | 'conversation-title' | 'tool-loop' }
>

export function createAgentTaskBinding(
  snapshot: AgentSnapshot,
  input: AgentTaskBindingInput
): AgentTaskBinding {
  if (snapshot.task !== input.task) throw new AgentRuntimeError('AGENT_PROTOCOL_ERROR')
  const copied = structuredClone(snapshot)
  const policy = getAgentTaskPolicy(input.task)
  switch (input.task) {
    case 'tts':
      return { task: input.task, policy, adapter: new TtsTask(input.host) }
    case 'vocabulary-practice-review':
      return { task: input.task, policy, adapter: new VocabularyPracticeTask(copied, input.host) }
    case 'sentence-practice-hints':
    case 'sentence-practice-review':
      return {
        task: input.task,
        policy,
        adapter: new SentencePracticeTask(input.task, copied, input.host)
      }
    case 'vocabulary':
      return { task: input.task, policy, adapter: new VocabularyTask(copied, input.host) }
    case 'phrase':
      return { task: input.task, policy, adapter: new PhraseTask(copied, input.host) }
    case 'synonym':
      return { task: input.task, policy, adapter: new SynonymTask(copied, input.host) }
    case 'explore-phrase':
      return { task: input.task, policy, adapter: new ExplorePhraseTask(copied, input.host) }
    case 'explore-vocabulary':
      return { task: input.task, policy, adapter: new ExploreVocabularyTask(copied, input.host) }
    case 'conversation':
    case 'conversation-title':
      return {
        task: input.task,
        policy,
        adapter: new ConversationTask(input.task, copied, input.resolveModel)
      }
    case 'tool-loop':
      if (!input.operations) throw new AgentRuntimeError('AGENT_PROTOCOL_ERROR')
      return { task: input.task, policy, adapter: new ToolLoopTask(copied, input.operations) }
    default: {
      const unreachable: never = input
      throw new AgentRuntimeError('AGENT_PROTOCOL_ERROR', { cause: unreachable })
    }
  }
}
