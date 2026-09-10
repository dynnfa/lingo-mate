import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { VocabularyPracticeDetail } from './VocabularyPracticeDetail'

interface PracticePageProps {
  onExit: () => void
}

type PracticeSection = 'vocabulary'

// 练习页骨架：左侧菜单当前只有“词汇练习”一项（默认选中），右侧渲染对应详情。
// 进入时焦点移至返回按钮；Escape 退出；退出后由调用方把焦点还给「开始练习」入口。
export function PracticePage({ onExit }: PracticePageProps): React.JSX.Element {
  const { t } = useTranslation('common')
  const backButtonRef = useRef<HTMLButtonElement>(null)
  const [section, setSection] = useState<PracticeSection>('vocabulary')

  useEffect(() => {
    backButtonRef.current?.focus()
  }, [])

  const handleKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    if (event.key !== 'Escape') return
    event.preventDefault()
    onExit()
  }

  return (
    <main aria-label={t('practice.title')} className="practice-page" onKeyDown={handleKeyDown}>
      <aside className="practice-menu">
        <div className="practice-menu-header">
          <button
            className="practice-back-button"
            onClick={onExit}
            ref={backButtonRef}
            type="button"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="m15 5-7 7 7 7" />
            </svg>
            {t('practice.back')}
          </button>
          <h2 className="practice-title">{t('practice.title')}</h2>
        </div>
        <nav aria-label={t('practice.menuLabel')} className="practice-menu-list">
          {(['vocabulary'] as const).map((item) => (
            <button
              aria-current={section === item ? 'true' : undefined}
              className="practice-menu-item"
              key={item}
              onClick={() => setSection(item)}
              type="button"
            >
              {t(`practice.sections.${item}`)}
            </button>
          ))}
        </nav>
      </aside>
      <section className="practice-detail">
        {section === 'vocabulary' ? <VocabularyPracticeDetail /> : null}
      </section>
    </main>
  )
}
