import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { normalizeI18nLocale } from '../../i18n'
import { formatDateTime } from '../../i18n/formatters'
import type { UsageBucket } from '../../../../shared/usage'
import { TokenUsageChart } from './TokenUsageChart'
import { usageErrorKey } from './usage-messages'
import {
  formatTokenNumber,
  formatWallDateFull,
  formatWeekRange,
  isEmptyUsageLedger,
  isUsageMetricUnknown,
  usageMetricUnknownCount,
  usageMetricValue
} from './usage-format'
import type { UsageStatisticsState } from './useUsageStatistics'

// 设置页“用量”区块：摘要卡、日/周维度切换、柱状图与数据表。
// 统计口径由 Core 决定；这里只负责展示、维度/周选择与刷新状态。
export function UsageSettings({ state }: { state: UsageStatisticsState }): React.JSX.Element {
  const { t, i18n } = useTranslation(['common', 'errors'])
  const [tableOpen, setTableOpen] = useState(false)
  const locale = normalizeI18nLocale(i18n.resolvedLanguage)
  const { loadState, overview, loadError, refreshing } = state

  if (loadState === 'idle' || loadState === 'loading') {
    return (
      <div
        aria-busy="true"
        aria-label={t('common:settings.usage.loading')}
        className="usage-skeleton"
        role="status"
      >
        <div className="usage-skeleton-summary">
          <span className="usage-skeleton-block" />
          <span className="usage-skeleton-block" />
        </div>
        <span className="usage-skeleton-block usage-skeleton-chart" />
      </div>
    )
  }

  if (loadState === 'error') {
    return (
      <div className="usage-load-error">
        <p className="settings-error" role="alert">
          {t(usageErrorKey(loadError ?? 'UNKNOWN_ERROR'))}
        </p>
        <button onClick={state.reload} type="button">
          {t('common:settings.usage.retryLoad')}
        </button>
      </div>
    )
  }

  if (!overview) return <></>

  const asOfLabel = formatDateTime(locale, overview.asOf)
  const emptyLedger = isEmptyUsageLedger(overview)
  const weekBuckets = overview.weeks
  const selectedWeekDays =
    state.selectedWeekKey !== undefined ? overview.dailyByWeek[state.selectedWeekKey] : undefined
  const selectedWeek = weekBuckets.find((week) => week.key === state.selectedWeekKey)

  return (
    <div className="usage-settings">
      <p className="settings-section-description">{t('common:settings.usage.description')}</p>

      <div className="usage-toolbar">
        <button disabled={refreshing} onClick={state.reload} type="button">
          {t('common:settings.usage.refresh')}
        </button>
        <span className="usage-refresh-status" role="status">
          {refreshing
            ? t('common:settings.usage.refreshing')
            : t('common:settings.usage.updatedAt', { time: asOfLabel })}
        </span>
      </div>
      {loadError !== undefined ? (
        <div className="usage-stale-error" role="alert">
          <p className="settings-error">
            {t('common:settings.usage.refreshFailedStale', { time: asOfLabel })}
          </p>
          <p className="settings-error">{t(usageErrorKey(loadError))}</p>
        </div>
      ) : null}

      <div className="usage-summary">
        <UsageSummaryCard
          asOfLabel={asOfLabel}
          bucket={overview.today}
          locale={locale}
          title={t('common:settings.usage.todayTitle')}
        />
        <UsageSummaryCard
          asOfLabel={asOfLabel}
          bucket={overview.thisWeek}
          locale={locale}
          title={t('common:settings.usage.thisWeekTitle')}
        />
      </div>

      <div
        aria-label={t('common:settings.usage.dimensionLabel')}
        className="usage-dimension"
        role="group"
      >
        <button
          aria-pressed={state.dimension === 'daily'}
          className="usage-dimension-option"
          onClick={() => state.setDimension('daily')}
          type="button"
        >
          {t('common:settings.usage.dailyDimension')}
        </button>
        <button
          aria-pressed={state.dimension === 'weekly'}
          className="usage-dimension-option"
          onClick={() => state.setDimension('weekly')}
          type="button"
        >
          {t('common:settings.usage.weeklyDimension')}
        </button>
      </div>

      {emptyLedger ? (
        <div className="usage-empty">
          <h3>{t('common:settings.usage.emptyTitle')}</h3>
          <p>{t('common:settings.usage.emptyBody')}</p>
          <p>
            {t('common:settings.usage.emptyTimeline', {
              start: formatWallDateFull(locale, overview.days[0].localStartDate),
              end: formatWallDateFull(
                locale,
                overview.days[overview.days.length - 1].localStartDate
              )
            })}
          </p>
        </div>
      ) : state.dimension === 'daily' ? (
        <TokenUsageChart
          buckets={overview.days}
          kind="day"
          locale={locale}
          title={t('common:settings.usage.dailyChartTitle')}
          titleId="usage-daily-chart-title"
        />
      ) : (
        <>
          <TokenUsageChart
            buckets={weekBuckets}
            kind="week"
            locale={locale}
            onSelect={state.selectWeek}
            selectedKey={state.selectedWeekKey}
            selectionHint={t('common:settings.usage.selectWeekHint')}
            title={t('common:settings.usage.weeklyChartTitle')}
            titleId="usage-weekly-chart-title"
          />
          {selectedWeek && selectedWeekDays ? (
            <TokenUsageChart
              buckets={selectedWeekDays}
              kind="day"
              locale={locale}
              title={t('common:settings.usage.weekDetailTitle', {
                range: formatWeekRange(
                  locale,
                  selectedWeek.localStartDate,
                  selectedWeek.localEndDate
                )
              })}
              titleId="usage-week-detail-title"
            />
          ) : null}
        </>
      )}

      {!emptyLedger ? (
        <div className="usage-table-section">
          <button
            aria-controls="usage-data-table"
            aria-expanded={tableOpen}
            className="usage-table-toggle"
            onClick={() => setTableOpen((open) => !open)}
            type="button"
          >
            {tableOpen
              ? t('common:settings.usage.tableHide')
              : t('common:settings.usage.tableShow')}
          </button>
          {tableOpen ? (
            <table className="usage-table" id="usage-data-table">
              <caption>{t('common:settings.usage.tableTitle')}</caption>
              <thead>
                <tr>
                  <th scope="col">{t('common:settings.usage.tableDate')}</th>
                  <th scope="col">{t('common:settings.usage.tableTotal')}</th>
                  <th scope="col">{t('common:settings.usage.tableInput')}</th>
                  <th scope="col">{t('common:settings.usage.tableOutput')}</th>
                  <th scope="col">{t('common:settings.usage.tableRequests')}</th>
                  <th scope="col">{t('common:settings.usage.tableStatus')}</th>
                </tr>
              </thead>
              <tbody>
                {state.dimension === 'daily'
                  ? overview.days.map((day) => (
                      <UsageTableRow bucket={day} key={day.key} locale={locale} />
                    ))
                  : weekBuckets.flatMap((week) => [
                      <UsageTableRow bucket={week} key={week.key} locale={locale} week />,
                      ...(week.key === state.selectedWeekKey && selectedWeekDays
                        ? selectedWeekDays.map((day) => (
                            <UsageTableRow
                              bucket={day}
                              key={`${week.key}/${day.key}`}
                              locale={locale}
                              nested
                            />
                          ))
                        : [])
                    ])}
              </tbody>
            </table>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

function UsageSummaryCard({
  title,
  bucket,
  locale,
  asOfLabel
}: {
  title: string
  bucket: UsageBucket
  locale: ReturnType<typeof normalizeI18nLocale>
  asOfLabel: string
}): React.JSX.Element {
  const { t } = useTranslation('common')
  const metricText = (metric: 'total' | 'input' | 'output'): string =>
    isUsageMetricUnknown(bucket, metric)
      ? t('settings.usage.unknownValue')
      : formatTokenNumber(locale, usageMetricValue(bucket, metric))

  const notes: string[] = []
  const totalUnknown = usageMetricUnknownCount(bucket, 'total')
  if (!isUsageMetricUnknown(bucket, 'total') && totalUnknown > 0) {
    notes.push(t('settings.usage.requestsWithoutUsage', { count: totalUnknown }))
  }
  if (bucket.invalidCount > 0) {
    notes.push(t('settings.usage.invalidRecords', { count: bucket.invalidCount }))
  }
  if (bucket.runningCount > 0) {
    notes.push(t('settings.usage.runningRequests', { count: bucket.runningCount }))
  }

  return (
    <section className="usage-card">
      <h3>{title}</h3>
      <p className="usage-card-asof">{t('settings.usage.asOf', { time: asOfLabel })}</p>
      <dl>
        <div>
          <dt>{t('settings.usage.totalLabel')}</dt>
          <dd>{metricText('total')}</dd>
        </div>
        <div>
          <dt>{t('settings.usage.inputLabel')}</dt>
          <dd>{metricText('input')}</dd>
        </div>
        <div>
          <dt>{t('settings.usage.outputLabel')}</dt>
          <dd>{metricText('output')}</dd>
        </div>
        <div>
          <dt>{t('settings.usage.requestsLabel')}</dt>
          <dd>{formatTokenNumber(locale, bucket.requestCount)}</dd>
        </div>
      </dl>
      {notes.length > 0 ? (
        <p className="usage-card-notes">
          {notes.map((note) => (
            <span key={note}>{note}</span>
          ))}
        </p>
      ) : null}
    </section>
  )
}

function UsageTableRow({
  bucket,
  locale,
  week = false,
  nested = false
}: {
  bucket: UsageBucket
  locale: ReturnType<typeof normalizeI18nLocale>
  week?: boolean
  nested?: boolean
}): React.JSX.Element {
  const { t } = useTranslation('common')
  const dateLabel = week
    ? formatWeekRange(locale, bucket.localStartDate, bucket.localEndDate)
    : formatWallDateFull(locale, bucket.localStartDate)
  const metricText = (metric: 'total' | 'input' | 'output'): string =>
    isUsageMetricUnknown(bucket, metric)
      ? t('settings.usage.unknownValue')
      : formatTokenNumber(locale, usageMetricValue(bucket, metric))

  const notes: string[] = []
  if (bucket.future) notes.push(t('settings.usage.futureLabel'))
  if (bucket.requestCount > 0 && isUsageMetricUnknown(bucket, 'total')) {
    notes.push(t('settings.usage.unknownValue'))
  }
  const totalUnknown = usageMetricUnknownCount(bucket, 'total')
  if (!isUsageMetricUnknown(bucket, 'total') && totalUnknown > 0) {
    notes.push(t('settings.usage.requestsWithoutUsage', { count: totalUnknown }))
  }
  if (bucket.invalidCount > 0) {
    notes.push(t('settings.usage.invalidRecords', { count: bucket.invalidCount }))
  }
  if (bucket.runningCount > 0) {
    notes.push(t('settings.usage.runningRequests', { count: bucket.runningCount }))
  }

  const classes = nested ? 'usage-table-row-nested' : week ? 'usage-table-row-week' : undefined
  return (
    <tr className={classes}>
      <th className={nested ? 'usage-table-date-nested' : undefined} scope="row">
        {dateLabel}
      </th>
      <td>{metricText('total')}</td>
      <td>{metricText('input')}</td>
      <td>{metricText('output')}</td>
      <td>{formatTokenNumber(locale, bucket.requestCount)}</td>
      <td>{notes.length > 0 ? notes.join('；') : '—'}</td>
    </tr>
  )
}
