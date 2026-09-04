import { useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import type { ConversationActionMeta } from './conversation-actions'

// 弹层容器与输入框 aria-controls 关联的稳定 ID；单实例composer下使用固定值。
export const ACTION_PICKER_ID = 'conversation-action-picker'

interface ConversationActionPickerProps {
  actions: readonly ConversationActionMeta[]
  highlightedActionId: string | null
  onSelect: (action: ConversationActionMeta) => void
  onHighlight: (actionId: string) => void
}

// `/` 行动选择弹层：只渲染候选、空状态并上报选择与高亮意图；
// 不读取会话状态、不调用 window.api，文案随当前界面语言重新翻译。
export function ConversationActionPicker({
  actions,
  highlightedActionId,
  onSelect,
  onHighlight
}: ConversationActionPickerProps): React.JSX.Element {
  const { t } = useTranslation(['conversation'])
  const containerRef = useRef<HTMLDivElement>(null)

  // 键盘或悬停移动高亮时保持该项可见；jsdom 未实现 scrollIntoView，需能力探测。
  useEffect(() => {
    if (!highlightedActionId) return
    const option = containerRef.current?.querySelector(`[data-action-id="${highlightedActionId}"]`)
    if (typeof option?.scrollIntoView === 'function') {
      option.scrollIntoView({ block: 'nearest' })
    }
  }, [highlightedActionId])

  return (
    // 按下弹层内任意位置都不转移焦点，避免输入框先失焦关闭弹层、点击落空。
    <div
      className="action-picker"
      id={ACTION_PICKER_ID}
      onMouseDown={(event) => event.preventDefault()}
      ref={containerRef}
    >
      {actions.length === 0 ? (
        <p className="action-picker-empty">{t('conversation:actionPicker.empty')}</p>
      ) : (
        <ul
          aria-label={t('conversation:actionPicker.listLabel')}
          className="action-picker-list"
          role="listbox"
        >
          {actions.map((action) => {
            const highlighted = action.id === highlightedActionId
            return (
              <li
                aria-selected={highlighted}
                className={
                  highlighted ? 'action-picker-option highlighted' : 'action-picker-option'
                }
                data-action-id={action.id}
                id={`conversation-action-option-${action.id}`}
                key={action.id}
                onClick={() => onSelect(action)}
                onMouseEnter={() => onHighlight(action.id)}
                role="option"
              >
                <div className="action-picker-option-main">
                  <span className="action-picker-option-name">{t(action.nameKey)}</span>
                  <span className="action-picker-option-command">/{action.command}</span>
                </div>
                <span className="action-picker-option-description">{t(action.descriptionKey)}</span>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
