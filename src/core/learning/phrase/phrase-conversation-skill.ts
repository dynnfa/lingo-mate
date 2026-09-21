import type { SupportedLocale } from '../../../shared/preferences'
import type { ConversationSkillReport } from '../../../shared/conversation'
import { isPhraseBatch } from '../../../shared/phrase'
import { PhraseModule } from './phrase-module'
import type { PhraseAnalyzer } from './phrase-analyzer'
import type { PhraseRepository } from './phrase-repository'
import type { PhraseFeedbackFormatter } from './phrase-feedback'
import type {
  ConversationSkill,
  ConversationSkillRunInput,
  ConversationSkillRunResult
} from '../../conversation/conversation-skill'

export class PhraseConversationSkill implements ConversationSkill {
  readonly skillId = 'phrase' as const

  constructor(
    private readonly repository: PhraseRepository,
    private readonly createAnalyzer: (timeoutMs: number) => PhraseAnalyzer,
    private readonly formatFeedback: PhraseFeedbackFormatter
  ) {}

  async run(input: ConversationSkillRunInput): Promise<ConversationSkillRunResult> {
    // 文本技能参数：由 ConversationModule 按 skillId 分派保证带 text 分支。
    if (!('text' in input.arguments)) throw new Error('Phrase skill requires text arguments')
    // 批次按需创建一次分析器，共享模型配置快照与模块的超时策略。
    const module = new PhraseModule(this.repository, this.createAnalyzer)
    const batch = await module.addBatch(
      {
        requestId: input.requestId,
        text: input.arguments.text,
        wordLanguage: input.arguments.wordLanguage
      },
      input.explanationLanguage,
      {
        executionId: input.executionId,
        signal: input.signal,
        onPhase: input.onPhase
      }
    )
    if (batch.outcome === 'cancelled') return { outcome: 'cancelled' }
    // summarizing 阶段只整理本地结果，不再调用模型描述。
    await input.onPhase('summarizing')
    return { outcome: 'completed', report: batch }
  }

  feedback(report: ConversationSkillReport, language: SupportedLocale): string {
    if (!isPhraseBatch(report)) throw new Error('Report does not match the phrase skill')
    return this.formatFeedback(report, language)
  }
}
