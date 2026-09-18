import type vocabulary from '../../../shared/locales/zh-CN/vocabulary.json'
import type common from './locales/zh-CN/common.json'
import type conversation from './locales/zh-CN/conversation.json'
import type errors from './locales/zh-CN/errors.json'

// 以 zh-CN 资源为类型基准：拼错的 key 在类型检查阶段暴露，
// 双语 key 集合一致性由 resources.test.ts 保证。
declare module 'i18next' {
  interface CustomTypeOptions {
    defaultNS: 'common'
    resources: {
      vocabulary: typeof vocabulary
      common: typeof common
      conversation: typeof conversation
      errors: typeof errors
    }
  }
}
