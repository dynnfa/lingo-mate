import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ConfirmDialog } from '../components/ConfirmDialog'
import { PageShell, type PageShellSection } from '../components/PageShell'
import { TargetLanguageSection } from './target-language/TargetLanguageSection'
import { UiLanguageSection } from './ui-language/UiLanguageSection'
import { ModelsSettings } from './models/ModelsSettings'
import { useModelsSettings } from './models/useModelsSettings'
import { UsageSettings } from './usage/UsageSettings'
import { useUsageStatistics } from './usage/useUsageStatistics'
import { ChannelsSettings } from './channels/ChannelsSettings'
import { useChannelsSettings } from './channels/useChannelsSettings'

// 设置区块注册表：新增设置时在此追加条目，左侧菜单随之扩展。
// 详情区各区块保持挂载并用 hidden 隐藏，模型草稿在菜单切换间不丢失。
const SETTINGS_SECTIONS = [
  {
    id: 'uiLanguage',
    labelKey: 'common:settings.sections.uiLanguage',
    titleId: 'settings-section-title-ui-language'
  },
  {
    id: 'targetLanguage',
    labelKey: 'common:settings.sections.targetLanguage',
    titleId: 'settings-section-title-target-language'
  },
  {
    id: 'models',
    labelKey: 'common:settings.sections.models',
    titleId: 'settings-section-title-models'
  },
  {
    id: 'usage',
    labelKey: 'common:settings.sections.usage',
    titleId: 'settings-section-title-usage'
  },
  {
    id: 'chatChannels',
    labelKey: 'common:settings.sections.chatChannels',
    titleId: 'settings-section-title-chat-channels'
  }
] as const

type SettingsSectionId = (typeof SETTINGS_SECTIONS)[number]['id']

interface SettingsPageProps {
  onExit: () => void
}

// 设置页：左侧菜单切换区块，右侧渲染对应详情（骨架由 PageShell 提供）。
// 进入时焦点移入返回按钮；Escape 优先关闭当前确认层或编辑表单，再执行退出，
// 一次按键只触发一个动作；退出后由调用方把焦点还给设置按钮。
// 模型区块有未保存修改时，返回或 Escape 先经过“继续编辑 / 放弃修改”确认。
export function SettingsPage({ onExit }: SettingsPageProps): React.JSX.Element {
  const { t } = useTranslation(['common', 'errors'])
  const [confirmDiscardOpen, setConfirmDiscardOpen] = useState(false)
  // 活动区块镜像：Escape 分层需要判断模型表单是否可见。
  const [activeSectionId, setActiveSectionId] = useState<SettingsSectionId>('uiLanguage')
  const modelsSettings = useModelsSettings()
  const usageStatistics = useUsageStatistics()
  const channelsSettings = useChannelsSettings()
  const backButtonRef = useRef<HTMLButtonElement>(null)

  // Usage 首次激活时读取数据，再次进入时重新读取；
  // 维度与选中周保留在本次设置页会话内。
  const handleSectionChange = (sectionId: string): void => {
    // 切离 Models 时中止在途连接测试（含草稿测试）；其余区块为无害空操作。
    modelsSettings.cancelActiveTest()
    setActiveSectionId(sectionId as SettingsSectionId)
    if (sectionId === 'usage') usageStatistics.reload()
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

  // Escape 分层：确认层（含本页与模型区块的对话框）由 ConfirmDialog 在遮罩层
  // 自行吞掉按键；这里只处理模型编辑表单与页面退出。
  const handleEscape = (): void => {
    if (activeSectionId === 'models' && modelsSettings.editSession.mode !== 'closed') {
      modelsSettings.requestCloseForm()
      return
    }
    requestExit()
  }

  const sectionBody = (sectionId: SettingsSectionId): React.JSX.Element => {
    if (sectionId === 'uiLanguage') return <UiLanguageSection />
    if (sectionId === 'targetLanguage') return <TargetLanguageSection />
    if (sectionId === 'models') return <ModelsSettings state={modelsSettings} />
    if (sectionId === 'chatChannels') return <ChannelsSettings state={channelsSettings} />
    return <UsageSettings state={usageStatistics} />
  }

  const sections: PageShellSection[] = SETTINGS_SECTIONS.map((section) => ({
    id: section.id,
    label: t(section.labelKey),
    keepMounted: true,
    labelledBy: section.titleId,
    content: (
      <>
        <h2 id={section.titleId}>{t(section.labelKey)}</h2>
        <div
          className={
            section.id === 'models'
              ? 'settings-section-body models-section-body'
              : section.id === 'usage'
                ? 'settings-section-body usage-section-body'
                : 'settings-section-body'
          }
        >
          {sectionBody(section.id)}
        </div>
      </>
    )
  }))

  return (
    <>
      <PageShell
        className="settings-page"
        exitButtonRef={backButtonRef}
        exitLabel={t('common:settings.back')}
        menuLabel={t('common:settings.menuLabel')}
        onEscape={handleEscape}
        onExit={requestExit}
        onSectionChange={handleSectionChange}
        sections={sections}
        title={t('common:settings.title')}
      />
      <ConfirmDialog
        cancelLabel={t('common:settings.models.discardConfirmKeepEditing')}
        confirmLabel={t('common:settings.models.discardConfirmDiscard')}
        description={t('common:settings.models.discardConfirmBody')}
        onCancel={() => setConfirmDiscardOpen(false)}
        onConfirm={discardChanges}
        open={confirmDiscardOpen}
        returnFocusRef={backButtonRef}
        title={t('common:settings.models.discardConfirmTitle')}
        tone="danger"
      />
    </>
  )
}
