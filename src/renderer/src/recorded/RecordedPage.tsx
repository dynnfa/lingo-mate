import { useEffect, useRef, type KeyboardEvent } from 'react'
import { useTranslation } from 'react-i18next'

interface RecordedPageProps {
  onExit: () => void
}

// 已记录页骨架：左侧菜单当前仅有词汇一项并默认选中，右侧是预留给词汇列表的空白容器。
// 进入时焦点移至返回按钮；Escape 退出；退出后由调用方把焦点还给「已记录」入口。
export function RecordedPage({ onExit }: RecordedPageProps): React.JSX.Element {
  const { t } = useTranslation('common')
  const backButtonRef = useRef<HTMLButtonElement>(null)

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
          <button aria-current="true" className="recorded-menu-item" type="button">
            {t('recorded.sections.vocabulary')}
          </button>
        </nav>
      </aside>
      <section className="recorded-detail" />
    </main>
  )
}
