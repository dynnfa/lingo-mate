import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ConfirmDialog } from '../../components/ConfirmDialog'
import { StateBlock } from '../../components/StateBlock'
import {
  VOCABULARY_PRACTICE_COUNT_MAX,
  VOCABULARY_PRACTICE_COUNT_MIN,
  VOCABULARY_PRACTICE_DEFAULT_COUNT,
  VOCABULARY_PRACTICE_MEANING_MAX_LENGTH
} from '../../../../shared/vocabulary-practice'
import { vocabularyPracticeErrorKey } from './vocabulary-practice-messages'
import { useVocabularyPractice } from './use-vocabulary-practice'

// 词汇练习详情：顶部确认数量开启新一轮，主体为左单词右释义的两列
// 练习区；提交后由模型审查，错误释义整行标红并显示原因。所有静态
// 文案走 i18n，模型返回的 summary 与 reason 按纯文本渲染。
export function VocabularyPracticeDetail(): React.JSX.Element {
  const { t } = useTranslation(['common', 'errors'])
  const { state, hasAnyAnswer, start, setAnswer, submit, cancelReview } = useVocabularyPractice()
  const [countInput, setCountInput] = useState(String(VOCABULARY_PRACTICE_DEFAULT_COUNT))
  const [countError, setCountError] = useState<'required' | 'invalid' | undefined>(undefined)
  const [confirmNewRound, setConfirmNewRound] = useState(false)
  const [pendingCount, setPendingCount] = useState<number | undefined>(undefined)
  const [submitBlocked, setSubmitBlocked] = useState(false)
  const confirmButtonRef = useRef<HTMLButtonElement>(null)
  const countInputRef = useRef<HTMLInputElement>(null)

  const practicing =
    state.phase === 'active' || state.phase === 'reviewing' || state.phase === 'done'
  const locked = state.phase !== 'active' && state.phase !== 'done'

  const beginRound = (count: number): void => {
    setConfirmNewRound(false)
    setPendingCount(undefined)
    setCountError(undefined)
    setSubmitBlocked(false)
    start(count)
  }

  const confirmCount = (): void => {
    const trimmed = countInput.trim()
    if (!trimmed) {
      setCountError('required')
      countInputRef.current?.focus()
      return
    }
    const count = Number(trimmed)
    if (
      !Number.isInteger(count) ||
      count < VOCABULARY_PRACTICE_COUNT_MIN ||
      count > VOCABULARY_PRACTICE_COUNT_MAX
    ) {
      setCountError('invalid')
      countInputRef.current?.focus()
      return
    }
    setCountError(undefined)
    // 有未提交答案时先确认再开启新一轮；审查中的在途请求由 start 取消。
    if (state.phase === 'active' && hasAnyAnswer) {
      setPendingCount(count)
      setConfirmNewRound(true)
      return
    }
    beginRound(count)
  }

  // 关闭后的焦点归还（回到确认按钮）由 ConfirmDialog 负责。
  const closeNewRoundDialog = (): void => {
    setConfirmNewRound(false)
    setPendingCount(undefined)
  }

  const requestReview = (): void => {
    if (state.phase !== 'active') return
    if (state.entries.some((entry) => !(state.answers[entry.entryId] ?? '').trim())) {
      setSubmitBlocked(true)
      return
    }
    setSubmitBlocked(false)
    submit()
  }

  const answerId = (entryId: string): string => `practice-meaning-${entryId}`

  return (
    <section aria-labelledby="vocabulary-practice-title" className="vocabulary-practice">
      <header className="vocabulary-practice-header">
        <h2 id="vocabulary-practice-title">{t('common:practice.vocabulary.detailTitle')}</h2>
        <form
          className="vocabulary-practice-setup"
          onSubmit={(event) => {
            event.preventDefault()
            confirmCount()
          }}
        >
          <label htmlFor="vocabulary-practice-count">
            {t('common:practice.vocabulary.countLabel')}
          </label>
          <input
            aria-invalid={countError ? 'true' : undefined}
            id="vocabulary-practice-count"
            inputMode="numeric"
            max={VOCABULARY_PRACTICE_COUNT_MAX}
            min={VOCABULARY_PRACTICE_COUNT_MIN}
            onChange={(event) => setCountInput(event.target.value)}
            ref={countInputRef}
            type="number"
            value={countInput}
          />
          <button disabled={state.phase === 'loading'} ref={confirmButtonRef} type="submit">
            {state.phase === 'loading'
              ? t('common:practice.vocabulary.loading')
              : t('common:practice.vocabulary.confirm')}
          </button>
          {countError ? (
            <p className="vocabulary-practice-field-error" role="alert">
              {countError === 'required'
                ? t('common:practice.vocabulary.countErrorRequired')
                : t('common:practice.vocabulary.countErrorInvalid')}
            </p>
          ) : null}
        </form>
        {state.error?.scope === 'start' ? (
          <StateBlock
            className="vocabulary-practice-error"
            message={t(vocabularyPracticeErrorKey(state.error.code))}
            title={t('common:practice.vocabulary.startFailedTitle')}
            variant="error"
          />
        ) : null}
      </header>

      {state.phase === 'loading' ? (
        <StateBlock
          className="vocabulary-practice-state"
          message={t('common:practice.vocabulary.loading')}
          variant="loading"
        />
      ) : state.phase === 'empty' ? (
        <StateBlock
          className="vocabulary-practice-state"
          message={t('common:practice.vocabulary.emptyBody')}
          title={t('common:practice.vocabulary.emptyTitle')}
          variant="empty"
        />
      ) : state.phase === 'idle' ? (
        <StateBlock
          className="vocabulary-practice-state"
          message={t('common:practice.vocabulary.idleBody')}
          title={t('common:practice.vocabulary.idleTitle')}
          variant="empty"
        />
      ) : null}

      {practicing ? (
        <div className="vocabulary-practice-body">
          {state.requestedCount !== undefined &&
          state.entries.length > 0 &&
          state.entries.length < state.requestedCount ? (
            <p className="vocabulary-practice-short" role="status">
              {t('common:practice.vocabulary.countShort', { count: state.entries.length })}
            </p>
          ) : null}

          <div className="vocabulary-practice-list">
            <div className="vocabulary-practice-column-headers">
              <span>{t('common:practice.vocabulary.termColumnLabel')}</span>
              <span>{t('common:practice.vocabulary.meaningColumnLabel')}</span>
            </div>
            <ul className="vocabulary-practice-rows">
              {state.entries.map((entry) => {
                const reason = state.marks[entry.entryId]
                const empty = submitBlocked && !(state.answers[entry.entryId] ?? '').trim()
                return (
                  <li
                    className={
                      reason
                        ? 'vocabulary-practice-row vocabulary-practice-row-marked'
                        : 'vocabulary-practice-row'
                    }
                    key={entry.entryId}
                  >
                    <span className="vocabulary-practice-term">{entry.term}</span>
                    <div className="vocabulary-practice-answer">
                      <input
                        aria-invalid={reason || empty ? 'true' : undefined}
                        aria-label={t('common:practice.vocabulary.answerLabel', {
                          term: entry.term
                        })}
                        className={
                          reason
                            ? 'vocabulary-practice-input vocabulary-practice-input-marked'
                            : 'vocabulary-practice-input'
                        }
                        id={answerId(entry.entryId)}
                        maxLength={VOCABULARY_PRACTICE_MEANING_MAX_LENGTH}
                        onChange={(event) => setAnswer(entry.entryId, event.target.value)}
                        readOnly={locked}
                        type="text"
                        value={state.answers[entry.entryId] ?? ''}
                      />
                      {reason ? (
                        <p className="vocabulary-practice-mark-reason" role="alert">
                          <span aria-hidden="true">⚠</span>
                          <span className="sr-only">
                            {t('common:practice.vocabulary.markedIconLabel')}
                            {': '}
                          </span>
                          {reason}
                        </p>
                      ) : null}
                    </div>
                  </li>
                )
              })}
            </ul>
          </div>

          {submitBlocked ? (
            <StateBlock
              className="vocabulary-practice-error"
              message={t('common:practice.vocabulary.submitBlockedBody')}
              title={t('common:practice.vocabulary.submitBlockedTitle')}
              variant="error"
            />
          ) : null}

          {state.notice === 'cancelled' ? (
            <p className="vocabulary-practice-notice" role="status">
              {t('common:practice.vocabulary.cancelledNotice')}
            </p>
          ) : null}

          {state.error?.scope === 'review' ? (
            <StateBlock
              className="vocabulary-practice-error"
              message={t(vocabularyPracticeErrorKey(state.error.code))}
              title={t('common:practice.vocabulary.reviewFailedTitle')}
              variant="error"
            />
          ) : null}

          {state.phase === 'reviewing' ? (
            <p aria-live="polite" className="vocabulary-practice-reviewing" role="status">
              {t('common:practice.vocabulary.reviewing')}
            </p>
          ) : null}

          {state.phase === 'done' && state.verdict ? (
            <div className="vocabulary-practice-feedback" role="status">
              <h3
                className={
                  state.verdict === 'all_correct'
                    ? 'vocabulary-practice-verdict vocabulary-practice-verdict-ok'
                    : 'vocabulary-practice-verdict vocabulary-practice-verdict-errors'
                }
              >
                {state.verdict === 'all_correct'
                  ? t('common:practice.vocabulary.verdictAllCorrect')
                  : t('common:practice.vocabulary.verdictHasErrors')}
              </h3>
              <p className="vocabulary-practice-summary">{state.summary}</p>
              <p className="vocabulary-practice-edit-hint">
                {t('common:practice.vocabulary.editAfterReviewNotice')}
              </p>
            </div>
          ) : null}

          <footer className="vocabulary-practice-actions">
            {state.phase === 'active' ? (
              <button className="vocabulary-practice-submit" onClick={requestReview} type="button">
                {t('common:practice.vocabulary.submit')}
              </button>
            ) : null}
            {state.phase === 'reviewing' ? (
              <button className="vocabulary-practice-cancel" onClick={cancelReview} type="button">
                {t('common:practice.vocabulary.cancelReview')}
              </button>
            ) : null}
          </footer>
        </div>
      ) : null}

      <ConfirmDialog
        cancelLabel={t('common:practice.vocabulary.confirmNewRoundCancel')}
        confirmLabel={t('common:practice.vocabulary.confirmNewRoundConfirm')}
        description={t('common:practice.vocabulary.confirmNewRoundBody')}
        onCancel={closeNewRoundDialog}
        onConfirm={() => beginRound(pendingCount ?? Number(countInput.trim()))}
        open={confirmNewRound}
        returnFocusRef={confirmButtonRef}
        title={t('common:practice.vocabulary.confirmNewRoundTitle')}
        tone="danger"
      />
    </section>
  )
}
