import type { SupportedLocale } from '../../shared/preferences'
import type { ConversationSkillReport, RunConversationSkillInput } from '../../shared/conversation'

// 会话技能的统一入口：ConversationModule 按 skillId 分派执行、反馈与恢复，
// 不通过类型断言把某个技能的报告当作另一个技能的报告。

export interface ConversationSkillRunInput {
  requestId: string
  executionId: string
  arguments: RunConversationSkillInput['arguments']
  explanationLanguage: SupportedLocale
  previousReport?: ConversationSkillReport
  signal: AbortSignal
  onPhase: (phase: 'analyzing' | 'committing' | 'summarizing') => void | Promise<void>
}

export type ConversationSkillRunResult =
  { outcome: 'completed'; report: ConversationSkillReport } | { outcome: 'cancelled' }

export interface ConversationSkill {
  readonly skillId: 'vocabulary' | 'phrase' | 'synonym'
  run(input: ConversationSkillRunInput): Promise<ConversationSkillRunResult>
  // 反馈由持久化报告驱动；实现内部负责判别报告类型并拒绝不匹配的载荷。
  feedback(report: ConversationSkillReport, language: SupportedLocale): string
}
