import * as electronStore from 'electron-store'
import type { PreferenceStore } from './preferences'
import type { TargetLanguage, UiLanguagePreference } from '../shared/preferences'

const UI_LANGUAGE_KEY = 'uiLanguage'
const TARGET_LANGUAGE_KEY = 'targetLanguage'
const LEGACY_LOCALE_PREFERENCE_KEY = 'localePreference'

// electron-store v11 是纯 ESM 包，而主进程产物是 CJS，default 导出的位置取决于加载方式：
// - ESM/vitest 直接加载：`ns.default` 即构造函数；
// - CJS 产物经打包器 _interopNamespaceDefault 包装后：`ns.default` 是整个模块对象，
//   构造函数在 `ns.default.default` 上。两种形态都在这里兼容。
interface ElectronStoreInstance {
  get(key: string): unknown
  set(key: string, value: unknown): void
}

type ElectronStoreConstructor = new (options: { name: string }) => ElectronStoreInstance

function resolveStoreConstructor(): ElectronStoreConstructor {
  const root = (electronStore as { default?: unknown }).default
  const candidate =
    typeof root === 'function'
      ? root
      : root != null && typeof root === 'object'
        ? (root as { default?: unknown }).default
        : undefined
  if (typeof candidate !== 'function') {
    throw new TypeError('electron-store default export is not a constructor')
  }
  return candidate as ElectronStoreConstructor
}

// 语言偏好复用 electron-store，写入应用用户数据目录的独立文件，
// 不触碰 SQLite schema，也不会清空其他配置。
export function createElectronPreferenceStore(): PreferenceStore {
  const StoreCtor = resolveStoreConstructor()
  const store = new StoreCtor({ name: 'preferences' })
  return {
    readUiLanguagePreference: () => store.get(UI_LANGUAGE_KEY),
    writeUiLanguagePreference: (preference: UiLanguagePreference): void => {
      store.set(UI_LANGUAGE_KEY, preference)
    },
    readTargetLanguage: () => store.get(TARGET_LANGUAGE_KEY),
    writeTargetLanguage: (language: TargetLanguage): void => {
      store.set(TARGET_LANGUAGE_KEY, language)
    },
    // 旧字段只读：升级后不再写入，读取迁移失败也不影响旧值保留在文件中。
    readLegacyLocalePreference: () => store.get(LEGACY_LOCALE_PREFERENCE_KEY)
  }
}
