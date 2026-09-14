import {
  useEffect,
  useRef,
  useState,
  Fragment,
  type KeyboardEvent,
  type ReactNode,
  type RefObject
} from 'react'
import './PageShell.css'

export interface PageShellSection {
  id: string
  label: string
  content: ReactNode
  // true：非激活时渲染但 hidden（设置页草稿保留不变量）；默认按需卸载。
  keepMounted?: boolean
  // keepMounted 面板的可访问名称关联（面板内标题元素的 id）。
  labelledBy?: string
}

export interface PageShellProps {
  title: string
  // 返回按钮文案（同时构成其可访问名称）。
  exitLabel: string
  menuLabel: string
  onExit: () => void
  // Escape 处理覆盖；缺省执行 onExit。设置页用它组合“先关表单再退出”分层。
  onEscape?: () => void
  // 页面专属样式钩子（现 settings-page 等）。
  className?: string
  sections: PageShellSection[]
  onSectionChange?: (sectionId: string) => void
  // 返回按钮 ref 透传：页面可用作对话框关闭后的焦点归还目标。
  exitButtonRef?: RefObject<HTMLButtonElement | null>
}

// 跨 menu 共享的页面骨架：左侧菜单（返回按钮 + 标题 + 导航），右侧详情。
// 进入时聚焦返回按钮，Escape 退出。组件不持有文案。
export function PageShell({
  title,
  exitLabel,
  menuLabel,
  onExit,
  onEscape,
  className,
  sections,
  onSectionChange,
  exitButtonRef
}: PageShellProps): React.JSX.Element {
  const [activeSectionId, setActiveSectionId] = useState(sections[0]?.id)
  const internalBackButtonRef = useRef<HTMLButtonElement>(null)
  const backButtonRef = exitButtonRef ?? internalBackButtonRef

  // 挂载（或 ref 来源变化）时聚焦返回按钮。
  useEffect(() => {
    backButtonRef.current?.focus()
  }, [backButtonRef])

  const switchSection = (sectionId: string): void => {
    if (sectionId === activeSectionId) return
    setActiveSectionId(sectionId)
    onSectionChange?.(sectionId)
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    if (event.key !== 'Escape') return
    event.preventDefault()
    if (onEscape !== undefined) onEscape()
    else onExit()
  }

  return (
    <main
      aria-label={title}
      className={className ? `page-shell ${className}` : 'page-shell'}
      onKeyDown={handleKeyDown}
    >
      <aside className="page-shell-menu">
        <div className="page-shell-menu-header">
          <button
            className="page-shell-back-button"
            onClick={onExit}
            ref={backButtonRef}
            type="button"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="m15 5-7 7 7 7" />
            </svg>
            {exitLabel}
          </button>
          <h2 className="page-shell-title">{title}</h2>
        </div>
        <nav aria-label={menuLabel} className="page-shell-menu-list">
          {sections.map((section) => (
            <button
              aria-current={section.id === activeSectionId ? 'true' : undefined}
              className="page-shell-menu-item"
              key={section.id}
              onClick={() => switchSection(section.id)}
              type="button"
            >
              {section.label}
            </button>
          ))}
        </nav>
      </aside>
      <section className="page-shell-detail">
        {sections.map((section) => {
          const active = section.id === activeSectionId
          if (section.keepMounted) {
            return (
              <div
                aria-labelledby={section.labelledBy}
                className="page-shell-pane"
                hidden={!active}
                key={section.id}
              >
                {section.content}
              </div>
            )
          }
          return active ? <Fragment key={section.id}>{section.content}</Fragment> : null
        })}
      </section>
    </main>
  )
}
