import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { LanguagePreferenceSection } from '../preferences/LanguagePreferenceSection'

// 设置区块注册表：新增设置时在此追加条目，左侧菜单与右侧详情随之扩展。
const SETTINGS_SECTIONS = [
  {
    id: 'language',
    labelKey: 'common:settings.sections.language',
    Component: LanguagePreferenceSection
  }
] as const

type SettingsSectionId = (typeof SETTINGS_SECTIONS)[number]['id']

interface SettingsPageProps {
  onExit: () => void
}

// 设置页：左侧菜单切换区块，右侧渲染对应详情。
// 进入时焦点移入返回按钮；Escape 等同返回，退出后由调用方把焦点还给设置按钮。
export function SettingsPage({ onExit }: SettingsPageProps): React.JSX.Element {
  const { t } = useTranslation(['common', 'errors'])
  const [activeSectionId, setActiveSectionId] = useState<SettingsSectionId>(SETTINGS_SECTIONS[0].id)
  const backButtonRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    backButtonRef.current?.focus()
  }, [])

  const handleKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    if (event.key === 'Escape') {
      event.preventDefault()
      onExit()
    }
  }

  const activeSection =
    SETTINGS_SECTIONS.find((section) => section.id === activeSectionId) ?? SETTINGS_SECTIONS[0]
  const ActiveSection = activeSection.Component

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
            onClick={onExit}
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
              onClick={() => setActiveSectionId(section.id)}
              type="button"
            >
              {t(section.labelKey)}
            </button>
          ))}
        </nav>
      </aside>
      <section aria-labelledby="settings-section-title" className="settings-detail">
        <h2 id="settings-section-title">{t(activeSection.labelKey)}</h2>
        <div className="settings-section-body">
          <ActiveSection />
        </div>
      </section>
    </main>
  )
}
