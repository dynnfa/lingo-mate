import type { VocabularyResultDescriber } from '../learning/vocabulary/vocabulary-result-describer'
import { vocabularyResultFacts } from '../learning/vocabulary/vocabulary-result-describer'
import { vocabularyResultSystemMessage } from '../prompt/vocabulary-result-summary'
import { ModelNotConfiguredError, type RuntimeModelConfig } from './model-config'
import {
  createModelClient,
  ModelRequestError,
  classifyModelRequestError
} from './remote-language-model'

export class LlmVocabularyResultDescriber implements VocabularyResultDescriber {
  constructor(
    private readonly config: RuntimeModelConfig,
    private readonly timeoutMs = 30_000
  ) {}

  async describe(input: Parameters<VocabularyResultDescriber['describe']>[0]): Promise<string> {
    try {
      if (!this.config.configured) throw new ModelNotConfiguredError()
      const client = createModelClient(this.config, this.timeoutMs)
      const result = await client.chat.completions.create(
        {
          model: this.config.modelId,
          messages: [
            { role: 'system', content: vocabularyResultSystemMessage(input.explanationLanguage) },
            { role: 'user', content: JSON.stringify(vocabularyResultFacts(input.batch)) }
          ]
        },
        { signal: input.signal }
      )
      const content = result.choices?.[0]?.message.content?.trim()
      if (!content || result.choices[0]?.finish_reason !== 'stop') {
        throw new ModelRequestError('PROTOCOL', new Error('Empty vocabulary result description'))
      }
      return content
    } catch (error) {
      if (input.signal.aborted) throw new DOMException('The operation was aborted', 'AbortError')
      if (error instanceof ModelRequestError) throw error
      throw new ModelRequestError(classifyModelRequestError(error), error)
    }
  }
}
