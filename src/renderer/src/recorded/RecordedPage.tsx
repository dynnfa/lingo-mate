import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { PhraseDetail } from './PhraseDetail'
import { SynonymDetail } from './SynonymDetail'
import { VocabularyDetail } from './VocabularyDetail'

interface RecordedPageProps {
  onExit: () => void
}

type RecordedSection = 'vocabulary' | 'phrase' | 'synonym'

// 已记录页骨架：左侧菜单含词汇、短语与近义词三项，默认选中词汇，右侧渲染对应详情。
// 切换菜单即卸载另一详情：视图状态不跨菜单保留，重新进入时读取最新列表。
// 进入时焦点移至返回按钮；Escape 退出；退出后由调用方把焦点还给「已记录」入口。
export function RecordedPage({ onExit }: RecordedPageProps): React.JSX.Element {
  const { t } = useTranslation('common')
  const backButtonRef = useRef<HTMLButtonElement>(null)
  const [section, setSection] = useState<RecordedSection>('vocabulary')

  useEffect(() => {
    backButtonRef.current?.focus()
  }, [])

  const handleKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    if (event.key !== 'Escape') return
    event.preventDefault()
    onExit()
  }

  return (
    <main aria-label={t('recorded.title')} className="recorded-page" onKeyDown={handleKeyDown}>
      <aside className="recorded-menu">
        <div className="recorded-menu-header">
          <button
            className="recorded-back-button"
            onClick={onExit}
            ref={backButtonRef}
            type="button"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="m15 5-7 7 7 7" />
            </svg>
            {t('recorded.back')}
          </button>
          <h2 className="recorded-title">{t('recorded.title')}</h2>
        </div>
        <nav aria-label={t('recorded.menuLabel')} className="recorded-menu-list">
          {(['vocabulary', 'phrase', 'synonym'] as const).map((item) => (
            <button
              aria-current={section === item ? 'true' : undefined}
              className="recorded-menu-item"
              key={item}
              onClick={() => setSection(item)}
              type="button"
            >
              {t(`recorded.sections.${item}`)}
            </button>
          ))}
        </nav>
      </aside>
      <section className="recorded-detail">
        {section === 'vocabulary' ? (
          <VocabularyDetail />
        ) : section === 'phrase' ? (
          <PhraseDetail />
        ) : (
          <SynonymDetail />
        )}
      </section>
    </main>
  )
}
