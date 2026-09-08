import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { TargetLanguageSection } from '../preferences/TargetLanguageSection'
import { UiLanguageSection } from '../preferences/UiLanguageSection'
import { ModelsSettings } from './ModelsSettings'
import { useModelsSettings } from './useModelsSettings'
import { UsageSettings } from './UsageSettings'
import { useUsageStatistics } from './useUsageStatistics'

// 设置区块注册表：新增设置时在此追加条目，左侧菜单随之扩展。
// 详情区各区块保持挂载并用 hidden 隐藏，模型草稿在菜单切换间不丢失。
const SETTINGS_SECTIONS = [
  {
    id: 'uiLanguage',
    labelKey: 'common:settings.sections.uiLanguage'
  },
  {
    id: 'targetLanguage',
    labelKey: 'common:settings.sections.targetLanguage'
  },
  {
    id: 'models',
    labelKey: 'common:settings.sections.models'
  },
  {
    id: 'usage',
    labelKey: 'common:settings.sections.usage'
  }
] as const

type SettingsSectionId = (typeof SETTINGS_SECTIONS)[number]['id']

interface SettingsPageProps {
  onExit: () => void
}

// 设置页：左侧菜单切换区块，右侧渲染对应详情。
// 进入时焦点移入返回按钮；Escape 优先关闭当前确认层或编辑表单，再执行退出，
// 一次按键只触发一个动作；退出后由调用方把焦点还给设置按钮。
// 模型区块有未保存修改时，返回或 Escape 先经过“继续编辑 / 放弃修改”确认。
export function SettingsPage({ onExit }: SettingsPageProps): React.JSX.Element {
  const { t } = useTranslation(['common', 'errors'])
  const [activeSectionId, setActiveSectionId] = useState<SettingsSectionId>(SETTINGS_SECTIONS[0].id)
  const [confirmDiscardOpen, setConfirmDiscardOpen] = useState(false)
  const modelsSettings = useModelsSettings()
  const usageStatistics = useUsageStatistics()
  const backButtonRef = useRef<HTMLButtonElement>(null)
  const discardKeepEditingRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    backButtonRef.current?.focus()
  }, [])

  // Usage 首次激活时读取数据，再次进入时重新读取；
  // 维度与选中周保留在本次设置页会话内。
  const reloadUsage = usageStatistics.reload
  useEffect(() => {
    if (activeSectionId === 'usage') reloadUsage()
  }, [activeSectionId, reloadUsage])

  useEffect(() => {
    if (confirmDiscardOpen) {
      discardKeepEditingRef.current?.focus()
    }
  }, [confirmDiscardOpen])

  // 切离 Models 时中止在途连接测试，但保留普通表单草稿。
  const switchSection = (sectionId: SettingsSectionId): void => {
    if (sectionId === activeSectionId) return
    if (activeSectionId === 'models') {
      modelsSettings.cancelActiveTest()
    }
    setActiveSectionId(sectionId)
  }

  const exitSettings = (): void => {
    modelsSettings.cancelActiveTest()
    onExit()
  }

  const requestExit = (): void => {
    if (modelsSettings.dirty) {
      setConfirmDiscardOpen(true)
      return
    }
    exitSettings()
  }

  const discardChanges = (): void => {
    setConfirmDiscardOpen(false)
    exitSettings()
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    if (event.key !== 'Escape') return
    event.preventDefault()
    // Escape 分层：先关本页确认层，再交给模型区块处理其确认层与编辑表单，
    // 最后才是退出设置。
    if (confirmDiscardOpen) {
      setConfirmDiscardOpen(false)
      return
    }
    if (activeSectionId === 'models' && modelsSettings.consumeEscape()) return
    requestExit()
  }

  return (
    <main
      aria-label={t('common:settings.title')}
      className="settings-page"
      onKeyDown={handleKeyDown}
    >
      <aside className="settings-menu">
        <div className="settings-menu-header">
          <button
            className="settings-back-button"
            onClick={requestExit}
            ref={backButtonRef}
            type="button"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="m15 5-7 7 7 7" />
            </svg>
            {t('common:settings.back')}
          </button>
          <h2 className="settings-title">{t('common:settings.title')}</h2>
        </div>
        <nav aria-label={t('common:settings.menuLabel')} className="settings-menu-list">
          {SETTINGS_SECTIONS.map((section) => (
            <button
              aria-current={section.id === activeSectionId ? 'true' : undefined}
              className="settings-menu-item"
              key={section.id}
              onClick={() => switchSection(section.id)}
              type="button"
            >
              {t(section.labelKey)}
            </button>
          ))}
        </nav>
      </aside>
      <section className="settings-detail">
        <div
          aria-labelledby="settings-section-title-ui-language"
          className="settings-detail-pane"
          hidden={activeSectionId !== 'uiLanguage'}
        >
          <h2 id="settings-section-title-ui-language">
            {t('common:settings.sections.uiLanguage')}
          </h2>
          <div className="settings-section-body">
            <UiLanguageSection />
          </div>
        </div>
        <div
          aria-labelledby="settings-section-title-target-language"
          className="settings-detail-pane"
          hidden={activeSectionId !== 'targetLanguage'}
        >
          <h2 id="settings-section-title-target-language">
            {t('common:settings.sections.targetLanguage')}
          </h2>
          <div className="settings-section-body">
            <TargetLanguageSection />
          </div>
        </div>
        <div
          aria-labelledby="settings-section-title-models"
          className="settings-detail-pane"
          hidden={activeSectionId !== 'models'}
        >
          <h2 id="settings-section-title-models">{t('common:settings.sections.models')}</h2>
          <div className="settings-section-body models-section-body">
            <ModelsSettings state={modelsSettings} />
          </div>
        </div>
        <div
          aria-labelledby="settings-section-title-usage"
          className="settings-detail-pane"
          hidden={activeSectionId !== 'usage'}
        >
          <h2 id="settings-section-title-usage">{t('common:settings.sections.usage')}</h2>
          <div className="settings-section-body usage-section-body">
            <UsageSettings state={usageStatistics} />
          </div>
        </div>
      </section>

      {confirmDiscardOpen ? (
        <div
          aria-describedby="settings-discard-confirm-body"
          aria-labelledby="settings-discard-confirm-title"
          className="settings-confirm"
          role="dialog"
        >
          <h3 id="settings-discard-confirm-title">
            {t('common:settings.models.discardConfirmTitle')}
          </h3>
          <p id="settings-discard-confirm-body">{t('common:settings.models.discardConfirmBody')}</p>
          <div className="settings-confirm-actions">
            <button
              onClick={() => setConfirmDiscardOpen(false)}
              ref={discardKeepEditingRef}
              type="button"
            >
              {t('common:settings.models.discardConfirmKeepEditing')}
            </button>
            <button className="settings-confirm-danger" onClick={discardChanges} type="button">
              {t('common:settings.models.discardConfirmDiscard')}
            </button>
          </div>
        </div>
      ) : null}
    </main>
  )
}
