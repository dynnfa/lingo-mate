import { useEffect, useRef, useState, type KeyboardEvent, type SyntheticEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { translateConversationStatus } from './status-messages'
import { MarkdownMessage } from './MarkdownMessage'
import { ACTION_PICKER_ID, ConversationActionPicker } from './ConversationActionPicker'
import {
  CONVERSATION_ACTIONS,
  extractSkillDraft,
  filterConversationActions,
  isSelectedSkillDraft,
  parseSlashTrigger,
  resolveSkillSubmission,
  type ConversationActionMeta,
  type SelectedConversationSkillId
} from './conversation-actions'
import type { ConversationStatus, DisplayMessage } from './conversation-state'

interface ConversationPanelProps {
  messages: DisplayMessage[]
  status: ConversationStatus
  generating: boolean
  composerLocked: boolean
  composerFocusRequest: number
  onSend: (text: string) => boolean | void | Promise<boolean | void>
  onRunSkill?: (input: {
    skillId: SelectedConversationSkillId
    text: string
  }) => boolean | void | Promise<boolean | void>
  onCancel: () => void
  onRetry: (messageId: string) => void
}

// 关闭抑制：显式关闭（Escape、未触发选择的 Tab）后同一草稿不因普通重渲染重开，
// 用户编辑或重新聚焦可重开；选择行动后的草稿需先失去 `/` 前缀才能重开。
type PickerDismissal = 'none' | 'soft' | 'latched'

// 右侧对话区：消息与状态全部来自 props，未发送草稿归本组件所有；
// 回调只表达交互意图，异步结果经 Controller 的状态投影反馈回来。
export function ConversationPanel({
  messages,
  status,
  generating,
  composerLocked,
  composerFocusRequest,
  onSend,
  onRunSkill,
  onCancel,
  onRetry
}: ConversationPanelProps): React.JSX.Element {
  const { t } = useTranslation(['common', 'conversation', 'errors'])
  const [draft, setDraft] = useState('')
  const [selectedSkillId, setSelectedSkillId] = useState<SelectedConversationSkillId | null>(null)
  const [composerError, setComposerError] = useState<string | null>(null)
  const [composing, setComposing] = useState(false)
  // 组合开始时的查询词：组合期间冻结候选，结束后再按最新草稿过滤。
  const [compositionQuery, setCompositionQuery] = useState<string | undefined>(undefined)
  const [inputFocused, setInputFocused] = useState(false)
  const [dismissal, setDismissal] = useState<PickerDismissal>('none')
  const [highlightedActionId, setHighlightedActionId] = useState<string | null>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const handledFocusRequestRef = useRef(0)

  useEffect(() => {
    if (composerFocusRequest <= handledFocusRequestRef.current || composerLocked) return
    handledFocusRequestRef.current = composerFocusRequest
    inputRef.current?.focus()
  }, [composerFocusRequest, composerLocked])

  const triggerQuery = parseSlashTrigger(draft)
  const filterQuery = composing ? compositionQuery : triggerQuery

  const pickerOpen =
    triggerQuery !== undefined && inputFocused && !composerLocked && dismissal === 'none'

  // 技能命令（选择器选择或完整输入 /phrase）激活时显示对应提示；
  // 短语提示说明多行输入规则。
  const activeSkillId = resolveSkillSubmission(draft, selectedSkillId)

  const filteredActions =
    pickerOpen && filterQuery !== undefined
      ? filterConversationActions(CONVERSATION_ACTIONS, filterQuery, (action) => t(action.nameKey))
      : []

  // 高亮身份存用户操作结果；派生时对当前候选兜底到第一项，避免过滤后越界。
  const highlightedId =
    highlightedActionId && filteredActions.some((action) => action.id === highlightedActionId)
      ? highlightedActionId
      : (filteredActions[0]?.id ?? null)

  const closePicker = (nextDismissal: 'soft' | 'latched'): void => {
    setDismissal(nextDismissal)
    setHighlightedActionId(null)
  }

  // 首版行动契约：选择仅填入命令模板进入待输入状态，不发送；
  // 替换后的草稿仍以 `/` 开头，用锁定抑制避免完成后立即弹回。
  const selectAction = (action: ConversationActionMeta): void => {
    if (action.id === 'vocabulary' || action.id === 'phrase' || action.id === 'synonym') {
      setSelectedSkillId(action.id)
      setDraft(`/${action.command} `)
      setComposerError(null)
      closePicker('latched')
      inputRef.current?.focus()
      return
    }
    setDraft(`/${action.command} `)
    closePicker('latched')
    inputRef.current?.focus()
  }

  const updateDraft = (nextDraft: string): void => {
    setDraft(nextDraft)
    setComposerError(null)
    if (!isSelectedSkillDraft(nextDraft, selectedSkillId)) {
      setSelectedSkillId(null)
      setDismissal('none')
    }
    // 草稿变化时重置高亮（查询变化后重新高亮第一项）。
    setHighlightedActionId(null)
    if (!nextDraft.startsWith('/')) {
      setDismissal('none')
    } else if (dismissal === 'soft') {
      setDismissal('none')
    }
  }

  const handleInputKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    // 输入法组合期间不拦截按键：确认键属于组合输入，不选择候选也不发送。
    if (composing || event.nativeEvent.isComposing) return
    // 弹层关闭时 Enter 发送（Shift+Enter 换行，服务短语多行输入）。
    if (!pickerOpen) {
      if (
        event.key === 'Enter' &&
        !event.shiftKey &&
        !event.ctrlKey &&
        !event.altKey &&
        !event.metaKey
      ) {
        event.preventDefault()
        submitComposer()
      }
      return
    }

    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      const count = filteredActions.length
      if (count === 0) return
      const currentIndex = filteredActions.findIndex((action) => action.id === highlightedId)
      const nextIndex =
        event.key === 'ArrowDown'
          ? currentIndex === -1
            ? 0
            : (currentIndex + 1) % count
          : currentIndex === -1
            ? count - 1
            : (currentIndex - 1 + count) % count
      setHighlightedActionId(filteredActions[nextIndex].id)
    } else if (event.key === 'Enter') {
      // 窗口打开时 Enter 只用于选择候选，必须阻止本次表单提交；
      // 无匹配项时同样吞掉，查询不能被误发为普通消息。
      event.preventDefault()
      const highlighted = filteredActions.find((action) => action.id === highlightedId)
      if (highlighted) selectAction(highlighted)
    } else if (event.key === 'Escape') {
      event.preventDefault()
      closePicker('soft')
    } else if (event.key === 'Tab') {
      // Shift+Tab 保留反向焦点导航：按原有行为关闭列表，但不选择候选。
      if (event.shiftKey) {
        closePicker('soft')
        return
      }
      // 其余修饰键组合属于系统/浏览器快捷键：不选择、不关闭、不拦截。
      if (event.ctrlKey || event.altKey || event.metaKey) return
      const highlighted = filteredActions.find((action) => action.id === highlightedId)
      if (highlighted) {
        // 与 Enter 同义的选择：补全命令并留在输入框继续输入参数，本次不发送。
        event.preventDefault()
        selectAction(highlighted)
      } else {
        // 无匹配项时不选择，仅关闭列表并允许默认焦点跳转。
        closePicker('soft')
      }
    }
  }

  const submitComposer = (): void => {
    // 弹层打开或输入法组合期间不发送；不能只依赖按钮禁用或键盘事件。
    if (pickerOpen || composing) return
    if (composerLocked || !draft.trim()) return

    // 技能命令（选择器选择或直接输入 /phrase）：转换为类型化技能请求，
    // 不作为普通聊天发送。
    if (activeSkillId) {
      const parsed = extractSkillDraft(draft, activeSkillId)
      if (parsed.status !== 'ok') {
        setComposerError(
          t(
            activeSkillId === 'synonym'
              ? 'conversation:composer.synonymRequired'
              : activeSkillId === 'phrase'
                ? 'conversation:composer.phraseRequired'
                : 'conversation:composer.vocabularyRequired'
          )
        )
        return
      }
      const submission = onRunSkill?.({ skillId: activeSkillId, text: parsed.text })
      const clearAcceptedSkill = (accepted: boolean | void): void => {
        if (accepted === false) return
        setSelectedSkillId(null)
        updateDraft('')
      }
      if (submission instanceof Promise) void submission.then(clearAcceptedSkill)
      else clearAcceptedSkill(submission)
      return
    }

    // 请求被 Main 接受后才清空草稿；IPC/校验失败时保留用户输入。
    const submission = onSend(draft)
    if (submission instanceof Promise) {
      void submission.then((accepted) => {
        if (accepted !== false) updateDraft('')
      })
    } else if (submission !== false) updateDraft('')
  }

  const sendMessage = (formEvent: SyntheticEvent): void => {
    formEvent.preventDefault()
    submitComposer()
  }

  return (
    <div className="conversation-panel">
      <header className="chat-header">
        <div>
          <p className="eyebrow">LINGO MATE</p>
          <h1>{t('common:app.title')}</h1>
        </div>
        <p aria-live="polite" className="status">
          {translateConversationStatus(t, status)}
        </p>
      </header>

      <section aria-label={t('common:messages.regionLabel')} className="messages">
        {messages.length === 0 ? (
          <div className="empty-state">
            <div aria-hidden="true" className="empty-mark">
              Aa
            </div>
            <h2>{t('common:messages.emptyTitle')}</h2>
            <p>{t('common:messages.emptyBody')}</p>
          </div>
        ) : (
          messages.map((message) => (
            <article
              className={`message ${message.role}`}
              data-message-id={message.messageId}
              key={message.messageId}
            >
              <span>{message.role === 'user' ? t('common:messages.userRole') : 'Lingo Mate'}</span>
              <MarkdownMessage content={message.content} />
              {message.role === 'user' && message.retryable && !composerLocked ? (
                <button
                  className="secondary retry"
                  onClick={() => onRetry(message.messageId)}
                  type="button"
                >
                  {t('common:messages.retry')}
                </button>
              ) : null}
            </article>
          ))
        )}
      </section>

      <form className="composer" onSubmit={sendMessage}>
        <div>
          {pickerOpen ? (
            <ConversationActionPicker
              actions={filteredActions}
              highlightedActionId={highlightedId}
              onHighlight={setHighlightedActionId}
              onSelect={selectAction}
            />
          ) : null}
          <textarea
            aria-activedescendant={
              pickerOpen && highlightedId
                ? `conversation-action-option-${highlightedId}`
                : undefined
            }
            aria-autocomplete="list"
            aria-controls={pickerOpen ? ACTION_PICKER_ID : undefined}
            aria-expanded={pickerOpen}
            aria-haspopup="listbox"
            aria-label={t('common:composer.label')}
            disabled={composerLocked}
            id="message"
            maxLength={4012}
            onBlur={() => setInputFocused(false)}
            onChange={(event) => updateDraft(event.target.value)}
            onCompositionEnd={() => setComposing(false)}
            onCompositionStart={() => {
              setComposing(true)
              setCompositionQuery(parseSlashTrigger(draft))
            }}
            onFocus={() => {
              setInputFocused(true)
              // soft 关闭（Escape、未触发选择的 Tab）后的重新聚焦允许重开；选择行动的锁定抑制不因此解除。
              if (dismissal === 'soft') setDismissal('none')
            }}
            onKeyDown={handleInputKeyDown}
            placeholder={
              activeSkillId === 'synonym'
                ? t('conversation:composer.synonymHint')
                : activeSkillId === 'phrase'
                  ? t('conversation:composer.phraseHint')
                  : t('common:composer.placeholder')
            }
            ref={inputRef}
            role="combobox"
            rows={1}
            value={draft}
          />
          {generating ? (
            <button className="secondary" onClick={onCancel} type="button">
              {t('common:composer.cancel')}
            </button>
          ) : (
            <button disabled={!draft.trim() || composerLocked || pickerOpen} type="submit">
              {t('common:composer.send')}
            </button>
          )}
        </div>
        {composerError ? (
          <p className="composer-error" role="alert">
            {composerError}
          </p>
        ) : null}
      </form>
    </div>
  )
}
