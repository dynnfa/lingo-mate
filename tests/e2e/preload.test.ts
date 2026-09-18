import { expect, launchApp, test, withTempUserData } from './helpers'

test('exposes the conversation skill and preferences interfaces from the sandboxed preload', async () => {
  await withTempUserData(async (userDataPath) => {
    const electronApp = await launchApp(userDataPath)
    try {
      const window = await electronApp.firstWindow()

      await expect
        .poll(() =>
          window.evaluate(
            () =>
              typeof (
                globalThis as typeof globalThis & { api?: { conversation?: { send?: unknown } } }
              ).api?.conversation?.send
          )
        )
        .toBe('function')

      // 偏好窄接口：只暴露语言设置读写，不暴露通用 invoke 或原始 IPC
      const exposedPreferencesKeys = await window.evaluate(() =>
        Object.keys(
          (globalThis as typeof globalThis & { api?: { preferences?: object } }).api?.preferences ??
            {}
        ).sort()
      )
      expect(exposedPreferencesKeys).toEqual([
        'getLanguageSettings',
        'setTargetLanguage',
        'setUiLanguage'
      ])

      const exposedApiKeys = await window.evaluate(() =>
        Object.keys((globalThis as typeof globalThis & { api?: object }).api ?? {}).sort()
      )
      expect(exposedApiKeys).toEqual([
        'conversation',
        'models',
        'phrase',
        'preferences',
        'sentencePractice',
        'synonym',
        'usage',
        'vocabulary',
        'vocabularyPractice'
      ])

      // 造句练习窄接口：只暴露开始、提示、点评、取消与释放
      const exposedSentencePracticeKeys = await window.evaluate(() =>
        Object.keys(
          (globalThis as typeof globalThis & { api?: { sentencePractice?: object } }).api
            ?.sentencePractice ?? {}
        ).sort()
      )
      expect(exposedSentencePracticeKeys).toEqual(['cancel', 'close', 'hints', 'review', 'start'])

      // 词汇练习窄接口：只暴露开始、审查与取消，不暴露通用 invoke 或会话内部状态
      const exposedVocabularyPracticeKeys = await window.evaluate(() =>
        Object.keys(
          (globalThis as typeof globalThis & { api?: { vocabularyPractice?: object } }).api
            ?.vocabularyPractice ?? {}
        ).sort()
      )
      expect(exposedVocabularyPracticeKeys).toEqual(['cancel', 'review', 'start'])

      // 用量窄接口：只暴露聚合读取，不暴露通用 invoke 或任意时间范围
      const exposedUsageKeys = await window.evaluate(() =>
        Object.keys(
          (globalThis as typeof globalThis & { api?: { usage?: object } }).api?.usage ?? {}
        ).sort()
      )
      expect(exposedUsageKeys).toEqual(['getOverview'])

      // 词汇窄接口：列表、删除与受控导入导出，不暴露通用 invoke、文件路径或任意 SQL
      const exposedVocabularyKeys = await window.evaluate(() =>
        Object.keys(
          (globalThis as typeof globalThis & { api?: { vocabulary?: object } }).api?.vocabulary ??
            {}
        ).sort()
      )
      expect(exposedVocabularyKeys).toEqual([
        'cancelImport',
        'confirmExcel',
        'delete',
        'downloadTemplate',
        'exportExcel',
        'getImportTask',
        'list',
        'onImportProgress',
        'previewExcel',
        'startImport'
      ])

      // 短语窄接口：只暴露列表与删除，不暴露通用 invoke 或任意 SQL
      const exposedPhraseKeys = await window.evaluate(() =>
        Object.keys(
          (globalThis as typeof globalThis & { api?: { phrase?: object } }).api?.phrase ?? {}
        ).sort()
      )
      expect(exposedPhraseKeys).toEqual(['delete', 'list'])

      // 近义词窄接口：只暴露分组列表读取，不暴露通用 invoke 或任意 SQL
      const exposedSynonymKeys = await window.evaluate(() =>
        Object.keys(
          (globalThis as typeof globalThis & { api?: { synonym?: object } }).api?.synonym ?? {}
        ).sort()
      )
      expect(exposedSynonymKeys).toEqual(['list'])

      const conversationKeys = await window.evaluate(() =>
        Object.keys(
          (
            globalThis as typeof globalThis & {
              api: { conversation: object }
            }
          ).api.conversation
        ).sort()
      )
      expect(conversationKeys).toContain('runSkill')

      const settings = await window.evaluate(async () => {
        const preferences = (
          globalThis as typeof globalThis & {
            api: { preferences: { getLanguageSettings(): Promise<unknown> } }
          }
        ).api.preferences
        return preferences.getLanguageSettings()
      })
      expect(settings).toMatchObject({ status: 'ok' })
    } finally {
      await electronApp.close()
    }
  })
})
