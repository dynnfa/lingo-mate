import type { ConversationSkillReport } from '../../../shared/conversation'
import {
  EXPLORE_PHRASE_SKILL_ID,
  isExplorePhraseReport,
  type ExplorePhraseReport
} from '../../../shared/explore-phrase'
import type {
  ConversationSkill,
  ConversationSkillRunInput,
  ConversationSkillRunResult
} from '../../conversation/conversation-skill'
import type { ExplorePhraseModule } from './explore-phrase-module'

// /explore-phrase 会话技能适配器：生成与提交委托 ExplorePhraseModule（串行锁
// 与 JSON 历史文件都在模块内），反馈由注入的本地格式化器生成 Markdown 表格。
export class ExplorePhraseConversationSkill implements ConversationSkill {
  readonly skillId = EXPLORE_PHRASE_SKILL_ID

  constructor(
    private readonly module: ExplorePhraseModule,
    private readonly formatFeedback: (report: ExplorePhraseReport) => string
  ) {}

  async run(input: ConversationSkillRunInput): Promise<ConversationSkillRunResult> {
    const result = await this.module.explore({
      executionId: input.executionId,
      sessionId: input.sessionId,
      userMessageId: input.userMessageId,
      wordLanguage: 'en',
      explanationLanguage: input.explanationLanguage,
      signal: input.signal,
      onPhase: input.onPhase,
      // 提交层以批次为保护单位；会话层回调以报告联合类型表达同一事实。
      isProtected: input.isReportProtected
        ? async (batch) => input.isReportProtected!({ skillId: EXPLORE_PHRASE_SKILL_ID, ...batch })
        : undefined
    })
    if (result.outcome === 'cancelled') return { outcome: 'cancelled' }
    // summarizing 阶段只做本地表格格式化，不再调用模型改写结果。
    await input.onPhase('summarizing')
    return {
      outcome: 'completed',
      report: { skillId: EXPLORE_PHRASE_SKILL_ID, ...result.batch }
    }
  }

  feedback(report: ConversationSkillReport): string {
    if (!isExplorePhraseReport(report)) {
      throw new Error('Report does not match the explore-phrase skill')
    }
    // 表头语言使用批次携带的解释语言快照：首次格式化与恢复保持一致。
    return this.formatFeedback(report)
  }

  async restoreReport(userMessageId: string): Promise<ConversationSkillReport | undefined> {
    const batch = await this.module.findBatch(userMessageId)
    return batch ? { skillId: EXPLORE_PHRASE_SKILL_ID, ...batch } : undefined
  }
}
