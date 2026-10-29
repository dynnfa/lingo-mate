import type { SupportedLocale } from '../../shared/preferences'
import type { ConversationSkillReport, RunConversationSkillInput } from '../../shared/conversation'

// 会话技能的统一入口：ConversationModule 按 skillId 分派执行、反馈与恢复，
// 不通过类型断言把某个技能的报告当作另一个技能的报告。

export interface ConversationSkillRunInput {
  requestId: string
  executionId: string
  // 会话与消息身份：探索技能的批次以 userMessageId 建立稳定关联，保存在
  // JSON 历史文件而非数据库执行记录中。
  sessionId: string
  userMessageId: string
  arguments: RunConversationSkillInput['arguments']
  explanationLanguage: SupportedLocale
  previousReport?: ConversationSkillReport
  signal: AbortSignal
  onPhase: (phase: 'analyzing' | 'committing' | 'summarizing') => void | Promise<void>
  // 提交前判断历史批次是否仍受保护：尚未补齐回复的批次不得被 7 批窗口淘汰。
  // 仅文件结果存储的技能（explore-phrase / explore-vocabulary）消费该回调。
  isReportProtected?: (report: ConversationSkillReport) => boolean | Promise<boolean>
}

export type ConversationSkillRunResult =
  { outcome: 'completed'; report: ConversationSkillReport } | { outcome: 'cancelled' }

export interface ConversationSkill {
  readonly skillId:
    | 'sentence'
    | 'tts'
    | 'vocabulary'
    | 'phrase'
    | 'synonym'
    | 'explore-phrase'
    | 'explore-vocabulary'
  run(input: ConversationSkillRunInput): Promise<ConversationSkillRunResult>
  // 反馈由持久化报告驱动；实现内部负责判别报告类型并拒绝不匹配的载荷。
  feedback(report: ConversationSkillReport, language: SupportedLocale): string
  // 可选恢复钩子：结果不在数据库报告列中的技能按稳定 userMessageId 从自有
  // 存储找回报告；数据库技能沿用既有持久化路径，不实现该方法。
  restoreReport?(userMessageId: string): Promise<ConversationSkillReport | undefined>
}
