import { synonymBatchSchema, type SynonymBatch } from '../../../shared/synonym'
import type { SupportedLocale } from '../../../shared/preferences'
import type {
  ConversationSkill,
  ConversationSkillRunInput,
  ConversationSkillRunResult
} from '../../conversation/conversation-skill'
import type { ConversationSkillReport } from '../../../shared/conversation'
import type { SynonymModule } from './synonym-module'
export class SynonymConversationSkill implements ConversationSkill {
  readonly skillId = 'synonym' as const
  constructor(
    private readonly module: SynonymModule,
    private readonly format: (report: SynonymBatch, language: SupportedLocale) => string
  ) {}
  async run(input: ConversationSkillRunInput): Promise<ConversationSkillRunResult> {
    const report = await this.module.addBatch(input)
    await input.onPhase('summarizing')
    // Even cancellation returns the local report so committed words remain visible.
    return { outcome: 'completed', report }
  }
  feedback(report: ConversationSkillReport, language: SupportedLocale): string {
    return this.format(synonymBatchSchema.parse(report), language)
  }
}
