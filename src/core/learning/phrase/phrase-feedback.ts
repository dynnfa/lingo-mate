import type { SupportedLocale } from '../../../shared/preferences'
import type { PhraseBatch } from '../../../shared/phrase'

// 本地反馈由已提交的批次报告驱动，不再调用模型；Main 注入 i18n 实现。
export type PhraseFeedbackFormatter = (batch: PhraseBatch, language: SupportedLocale) => string
