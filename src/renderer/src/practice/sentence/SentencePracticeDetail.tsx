import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { SENTENCE_PRACTICE_ANSWER_MAX_LENGTH } from '../../../../shared/sentence-practice'
import { sentencePracticeErrorKey } from './sentence-practice-messages'
import { useSentencePractice } from './use-sentence-practice'

// 造句练习详情：顶部三个随机单词与换组入口，中间 LLM 生成的短语提示，
// 底部 Textarea 造句；提交后按单词使用、通顺度与语法三个维度展示
// 点评。结论均以图标 + 文本表达，不只依赖颜色；模型返回文本按纯文本渲染。
export function SentencePracticeDetail(): React.JSX.Element {
  const { t } = useTranslation(['common', 'errors'])
  const { state, startRound, regenerateHints, setAnswer, submit, cancelActive } =
    useSentencePractice()
  const [confirmNewRound, setConfirmNewRound] = useState(false)
  const [submitBlocked, setSubmitBlocked] = useState(false)
  const dialogCancelButtonRef = useRef<HTMLButtonElement>(null)
  const newRoundButtonRef = useRef<HTMLButtonElement>(null)

  // 进入造句练习自动开始一轮；重复挂载由 hook 的迟到守卫收敛。
  useEffect(() => {
    startRound()
  }, [startRound])

  useEffect(() => {
    if (confirmNewRound) dialogCancelButtonRef.current?.focus()
  }, [confirmNewRound])

  const practicing =
    state.phase === 'hinting' ||
    state.phase === 'hintFailed' ||
    state.phase === 'ready' ||
    state.phase === 'reviewing' ||
    state.phase === 'done'
  const answering = state.phase === 'ready' || state.phase === 'done'

  const requestNewRound = (): void => {
    // 已有答案时先确认再换组，避免误清空。
    if (state.answer.trim()) {
      setConfirmNewRound(true)
      return
    }
    setSubmitBlocked(false)
    startRound()
  }

  const beginNewRound = (): void => {
    setConfirmNewRound(false)
    setSubmitBlocked(false)
    startRound()
  }

  const closeNewRoundDialog = (): void => {
    setConfirmNewRound(false)
    newRoundButtonRef.current?.focus()
  }

  const handleDialogKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== 'Escape') return
    // Escape 只关闭对话框，不冒泡退出练习页。
    event.preventDefault()
    event.stopPropagation()
    closeNewRoundDialog()
  }

  const requestReview = (): void => {
    if (state.phase !== 'ready') return
    // 前端与 Core 同口径校验：去首尾空白后须非空。
    if (!state.answer.trim()) {
      setSubmitBlocked(true)
      return
    }
    setSubmitBlocked(false)
    submit()
  }

  const review = state.review
  const usageByEntry = review
    ? new Map(review.wordUsage.map((usage) => [usage.entryId, usage]))
    : undefined
  // 总体通过仅在全部词正确使用、通顺且语法正确时展示。
  const allPassed =
    review !== undefined &&
    review.wordUsage.every((usage) => usage.used && usage.correct) &&
    review.fluency.natural &&
    review.grammar.correct

  return (
    <section aria-labelledby="sentence-practice-title" className="sentence-practice">
      <header className="sentence-practice-header">
        <h2 id="sentence-practice-title">{t('common:practice.sentence.detailTitle')}</h2>
        <button
          className="sentence-practice-new-round"
          disabled={state.phase === 'loading'}
          onClick={requestNewRound}
          ref={newRoundButtonRef}
          type="button"
        >
          {t('common:practice.sentence.newRound')}
        </button>
      </header>

      {state.error?.scope === 'start' ? (
        <div className="sentence-practice-error" role="alert">
          <p className="sentence-practice-error-title">
            {t('common:practice.sentence.startFailedTitle')}
          </p>
          <p>{t(sentencePracticeErrorKey(state.error.code))}</p>
        </div>
      ) : null}

      {state.phase === 'loading' ? (
        <div aria-busy="true" className="sentence-practice-state" role="status">
          {t('common:practice.sentence.loading')}
        </div>
      ) : state.phase === 'empty' ? (
        <div className="sentence-practice-state">
          <p className="sentence-practice-state-title">
            {t('common:practice.sentence.emptyTitle')}
          </p>
          <p>{t('common:practice.sentence.emptyCount', { count: state.entries.length })}</p>
          <p>{t('common:practice.sentence.emptyBody')}</p>
        </div>
      ) : null}

      {practicing ? (
        <div className="sentence-practice-body">
          <div className="sentence-practice-words">
            <h3>{t('common:practice.sentence.wordsLabel')}</h3>
            <ul className="sentence-practice-word-list">
              {state.entries.map((entry) => (
                <li className="sentence-practice-word" key={entry.entryId}>
                  {entry.term}
                </li>
              ))}
            </ul>
          </div>

          <div className="sentence-practice-hints">
            <h3>{t('common:practice.sentence.hintsLabel')}</h3>
            {state.phase === 'hinting' ? (
              <p aria-live="polite" className="sentence-practice-status" role="status">
                {t('common:practice.sentence.hintsLoading')}
              </p>
            ) : state.phase === 'hintFailed' ? (
              <div className="sentence-practice-hint-failed">
                <div className="sentence-practice-error" role="alert">
                  <p className="sentence-practice-error-title">
                    {t('common:practice.sentence.hintsFailedTitle')}
                  </p>
                  {state.error?.scope === 'hints' ? (
                    <p>{t(sentencePracticeErrorKey(state.error.code))}</p>
                  ) : null}
                </div>
                <button
                  className="sentence-practice-retry-hints"
                  onClick={regenerateHints}
                  type="button"
                >
                  {t('common:practice.sentence.hintsRetry')}
                </button>
              </div>
            ) : state.hints ? (
              <ul className="sentence-practice-hint-list">
                {state.hints.map((hint, index) => (
                  <li className="sentence-practice-hint" key={index}>
                    <span className="sentence-practice-hint-phrase">{hint.phrase}</span>
                    <span className="sentence-practice-hint-explanation">{hint.explanation}</span>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>

          <div className="sentence-practice-answer">
            <label htmlFor="sentence-practice-answer">
              {t('common:practice.sentence.answerLabel')}
            </label>
            <textarea
              className="sentence-practice-textarea"
              disabled={!answering}
              id="sentence-practice-answer"
              maxLength={SENTENCE_PRACTICE_ANSWER_MAX_LENGTH}
              onChange={(event) => setAnswer(event.target.value)}
              placeholder={t('common:practice.sentence.answerPlaceholder')}
              rows={4}
              value={state.answer}
            />
          </div>

          {submitBlocked ? (
            <div className="sentence-practice-error" role="alert">
              <p className="sentence-practice-error-title">
                {t('common:practice.sentence.submitBlockedTitle')}
              </p>
              <p>{t('common:practice.sentence.submitBlockedBody')}</p>
            </div>
          ) : null}

          {state.notice === 'cancelled' ? (
            <p className="sentence-practice-notice" role="status">
              {t('common:practice.sentence.cancelledNotice')}
            </p>
          ) : null}

          {state.error?.scope === 'review' ? (
            <div className="sentence-practice-error" role="alert">
              <p className="sentence-practice-error-title">
                {t('common:practice.sentence.reviewFailedTitle')}
              </p>
              <p>{t(sentencePracticeErrorKey(state.error.code))}</p>
            </div>
          ) : null}

          {state.phase === 'reviewing' ? (
            <p aria-live="polite" className="sentence-practice-status" role="status">
              {t('common:practice.sentence.reviewing')}
            </p>
          ) : null}

          {state.phase === 'done' && review ? (
            <div className="sentence-practice-feedback" role="status">
              <h3>{t('common:practice.sentence.reviewTitle')}</h3>
              {allPassed ? (
                <p className="sentence-practice-verdict sentence-practice-verdict-ok">
                  {t('common:practice.sentence.allPassed')}
                </p>
              ) : null}

              <div className="sentence-practice-feedback-section">
                <h4>{t('common:practice.sentence.usageLabel')}</h4>
                <ul className="sentence-practice-usage-list">
                  {state.entries.map((entry) => {
                    const usage = usageByEntry?.get(entry.entryId)
                    if (!usage) return null
                    const label = !usage.used
                      ? t('common:practice.sentence.usageMissing')
                      : usage.correct
                        ? t('common:practice.sentence.usageCorrect')
                        : t('common:practice.sentence.usageIncorrect')
                    const icon = usage.used && usage.correct ? '✓' : '✕'
                    const tone =
                      usage.used && usage.correct
                        ? 'sentence-practice-check sentence-practice-check-ok'
                        : 'sentence-practice-check sentence-practice-check-bad'
                    return (
                      <li className="sentence-practice-usage" key={entry.entryId}>
                        <p className="sentence-practice-usage-head">
                          <span aria-hidden="true" className={tone}>
                            {icon}
                          </span>
                          <span className="sentence-practice-usage-term">{entry.term}</span>
                          <span
                            className={
                              usage.used && usage.correct
                                ? 'sentence-practice-usage-state sentence-practice-usage-state-ok'
                                : 'sentence-practice-usage-state sentence-practice-usage-state-bad'
                            }
                          >
                            {label}
                          </span>
                        </p>
                        <p className="sentence-practice-usage-feedback">{usage.feedback}</p>
                      </li>
                    )
                  })}
                </ul>
              </div>

              <div className="sentence-practice-feedback-section">
                <h4>{t('common:practice.sentence.fluencyLabel')}</h4>
                <p className="sentence-practice-usage-head">
                  <span
                    aria-hidden="true"
                    className={
                      review.fluency.natural
                        ? 'sentence-practice-check sentence-practice-check-ok'
                        : 'sentence-practice-check sentence-practice-check-bad'
                    }
                  >
                    {review.fluency.natural ? '✓' : '✕'}
                  </span>
                  <span
                    className={
                      review.fluency.natural
                        ? 'sentence-practice-usage-state sentence-practice-usage-state-ok'
                        : 'sentence-practice-usage-state sentence-practice-usage-state-bad'
                    }
                  >
                    {review.fluency.natural
                      ? t('common:practice.sentence.fluencyNatural')
                      : t('common:practice.sentence.fluencyUnnatural')}
                  </span>
                </p>
                <p className="sentence-practice-usage-feedback">{review.fluency.feedback}</p>
              </div>

              <div className="sentence-practice-feedback-section">
                <h4>{t('common:practice.sentence.grammarLabel')}</h4>
                <p className="sentence-practice-usage-head">
                  <span
                    aria-hidden="true"
                    className={
                      review.grammar.correct
                        ? 'sentence-practice-check sentence-practice-check-ok'
                        : 'sentence-practice-check sentence-practice-check-bad'
                    }
                  >
                    {review.grammar.correct ? '✓' : '✕'}
                  </span>
                  <span
                    className={
                      review.grammar.correct
                        ? 'sentence-practice-usage-state sentence-practice-usage-state-ok'
                        : 'sentence-practice-usage-state sentence-practice-usage-state-bad'
                    }
                  >
                    {review.grammar.correct
                      ? t('common:practice.sentence.grammarCorrect')
                      : t('common:practice.sentence.grammarIncorrect')}
                  </span>
                </p>
                {review.grammar.issues.length > 0 ? (
                  <ul className="sentence-practice-issue-list">
                    {review.grammar.issues.map((issue, index) => (
                      <li className="sentence-practice-issue" key={index}>
                        <p className="sentence-practice-issue-text">
                          <span className="sentence-practice-issue-original">{issue.original}</span>
                          <span aria-hidden="true"> → </span>
                          <span className="sentence-practice-issue-suggestion">
                            {issue.suggestion}
                          </span>
                        </p>
                        <p className="sentence-practice-usage-feedback">{issue.explanation}</p>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </div>

              <div className="sentence-practice-feedback-section">
                <h4>{t('common:practice.sentence.summaryLabel')}</h4>
                <p className="sentence-practice-usage-feedback">{review.summary}</p>
              </div>

              {review.revisedAnswer ? (
                <div className="sentence-practice-feedback-section">
                  <h4>{t('common:practice.sentence.revisedAnswerLabel')}</h4>
                  <p className="sentence-practice-revised">{review.revisedAnswer}</p>
                </div>
              ) : null}

              <p className="sentence-practice-edit-hint">
                {t('common:practice.sentence.editAfterReviewNotice')}
              </p>
            </div>
          ) : null}

          <footer className="sentence-practice-actions">
            {state.phase === 'ready' ? (
              <button className="sentence-practice-submit" onClick={requestReview} type="button">
                {t('common:practice.sentence.submit')}
              </button>
            ) : null}
            {state.phase === 'hinting' || state.phase === 'reviewing' ? (
              <button className="sentence-practice-cancel" onClick={cancelActive} type="button">
                {t('common:practice.sentence.cancel')}
              </button>
            ) : null}
          </footer>
        </div>
      ) : null}

      {confirmNewRound ? (
        <div className="dialog-backdrop" onKeyDown={handleDialogKeyDown}>
          <div
            aria-labelledby="sentence-practice-new-round-title"
            aria-modal="true"
            className="dialog-card"
            role="dialog"
          >
            <h3 id="sentence-practice-new-round-title">
              {t('common:practice.sentence.confirmNewRoundTitle')}
            </h3>
            <p className="dialog-text">{t('common:practice.sentence.confirmNewRoundBody')}</p>
            <div className="dialog-actions">
              <button
                className="dialog-cancel-button"
                onClick={closeNewRoundDialog}
                ref={dialogCancelButtonRef}
                type="button"
              >
                {t('common:practice.sentence.confirmNewRoundCancel')}
              </button>
              <button className="dialog-danger-button" onClick={beginNewRound} type="button">
                {t('common:practice.sentence.confirmNewRoundConfirm')}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  )
}
