import { useRef, useState, type KeyboardEvent } from 'react'
import { useTranslation } from 'react-i18next'
import type { SupportedLocale } from '../../../shared/preferences'
import type { UsageBucket } from '../../../shared/usage'
import {
  formatTokenCompact,
  formatTokenNumber,
  formatWallDateCompact,
  formatWallDateFull,
  formatWeekRange,
  isUsageMetricUnknown,
  usageMetricUnknownCount,
  usageMetricValue
} from './usage-format'

// 简单 SVG 柱状图：纵轴从 0 开始、标注 token；柱形支持悬停/键盘聚焦
// 查看数值详情，周模式支持键盘选择周。数值不只依赖颜色传达——详情
// 区与数据表承载完整数字。
interface TokenUsageChartProps {
  titleId: string
  title: string
  buckets: UsageBucket[]
  kind: 'day' | 'week'
  locale: SupportedLocale
  selectedKey?: string
  onSelect?: (bucketKey: string) => void
  selectionHint?: string
}

const VIEW_WIDTH = 760
const VIEW_HEIGHT = 240
const MARGIN = { top: 18, right: 8, bottom: 30, left: 56 }

export function TokenUsageChart({
  titleId,
  title,
  buckets,
  kind,
  locale,
  selectedKey,
  onSelect,
  selectionHint
}: TokenUsageChartProps): React.JSX.Element {
  const { t } = useTranslation('common')
  const [activeKey, setActiveKey] = useState<string | undefined>(undefined)
  const barRefs = useRef<Array<SVGGElement | null>>([])

  const plotWidth = VIEW_WIDTH - MARGIN.left - MARGIN.right
  const plotHeight = VIEW_HEIGHT - MARGIN.top - MARGIN.bottom
  const baselineY = MARGIN.top + plotHeight
  const maxTotal = Math.max(...buckets.map((bucket) => bucket.totalTokens), 0)
  const scaleMax = niceCeil(maxTotal)
  // scaleMax 为 1 时中位刻度 0.5 取整后会与顶端重复，只保留两端
  const ticks = scaleMax === 1 ? [0, scaleMax] : [0, scaleMax / 2, scaleMax]
  const slot = plotWidth / buckets.length
  const barWidth = Math.min(slot * 0.68, 48)
  // 横轴标签最多约 7 个，避免 30 天刻度互相挤压；始终包含最后一根。
  const labelStride = Math.max(1, Math.ceil(buckets.length / 7))
  const hasFuture = buckets.some((bucket) => bucket.future)
  const hasUnknown = buckets.some(
    (bucket) => bucket.requestCount > 0 && isUsageMetricUnknown(bucket, 'total')
  )

  const bucketLabel = (bucket: UsageBucket): string =>
    kind === 'week'
      ? formatWeekRange(locale, bucket.localStartDate, bucket.localEndDate)
      : formatWallDateFull(locale, bucket.localStartDate)

  const axisLabel = (bucket: UsageBucket): string =>
    formatWallDateCompact(locale, bucket.localStartDate)

  const metricText = (bucket: UsageBucket, metric: 'total' | 'input' | 'output'): string =>
    isUsageMetricUnknown(bucket, metric)
      ? t('settings.usage.unknownValue')
      : formatTokenNumber(locale, usageMetricValue(bucket, metric))

  const completenessNotes = (bucket: UsageBucket): string[] => {
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
    return notes
  }

  const barAriaLabel = (bucket: UsageBucket): string => {
    const parts = [
      bucketLabel(bucket),
      `${t('settings.usage.totalLabel')} ${metricText(bucket, 'total')}`,
      `${t('settings.usage.inputLabel')} ${metricText(bucket, 'input')}`,
      `${t('settings.usage.outputLabel')} ${metricText(bucket, 'output')}`,
      `${t('settings.usage.requestsLabel')} ${formatTokenNumber(locale, bucket.requestCount)}`,
      ...completenessNotes(bucket)
    ]
    if (onSelect) parts.push(selectionHint ?? '')
    return parts.filter((part) => part.length > 0).join('，')
  }

  const focusBar = (index: number): void => {
    barRefs.current[index]?.focus()
  }

  const handleBarKeyDown = (event: KeyboardEvent<SVGGElement>, index: number): void => {
    if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
      event.preventDefault()
      const step = event.key === 'ArrowRight' ? 1 : -1
      focusBar(Math.min(buckets.length - 1, Math.max(0, index + step)))
      return
    }
    if (event.key === 'Home') {
      event.preventDefault()
      focusBar(0)
      return
    }
    if (event.key === 'End') {
      event.preventDefault()
      focusBar(buckets.length - 1)
      return
    }
    if (onSelect && (event.key === 'Enter' || event.key === ' ')) {
      event.preventDefault()
      onSelect(buckets[index].key)
    }
  }

  const activeBucket = buckets.find((bucket) => bucket.key === activeKey)

  return (
    <div className="usage-chart-block">
      <h3 id={titleId}>{title}</h3>
      <svg
        aria-labelledby={titleId}
        className="usage-chart"
        preserveAspectRatio="xMidYMid meet"
        role="group"
        viewBox={`0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}`}
      >
        {/* 纵轴单位标注 */}
        <text className="usage-chart-unit" x={MARGIN.left} y={10}>
          {t('settings.usage.yAxisUnit')}
        </text>
        {ticks.map((tick) => {
          const y = baselineY - (tick / scaleMax) * plotHeight
          return (
            <g key={tick}>
              <line
                className="usage-gridline"
                x1={MARGIN.left}
                x2={VIEW_WIDTH - MARGIN.right}
                y1={y}
                y2={y}
              />
              <text className="usage-chart-tick" textAnchor="end" x={MARGIN.left - 6} y={y + 4}>
                {formatTokenCompact(locale, Math.round(tick))}
              </text>
            </g>
          )
        })}
        <line
          className="usage-axis-line"
          x1={MARGIN.left}
          x2={VIEW_WIDTH - MARGIN.right}
          y1={baselineY}
          y2={baselineY}
        />
        {buckets.map((bucket, index) => {
          const barX = MARGIN.left + slot * index + (slot - barWidth) / 2
          const barHeight = (bucket.totalTokens / scaleMax) * plotHeight
          const unknownMarked =
            bucket.requestCount > 0 &&
            !bucket.future &&
            isUsageMetricUnknown(bucket, 'total') &&
            bucket.totalTokens === 0
          const isSelected = selectedKey === bucket.key
          const classes = ['usage-bar']
          if (bucket.future) classes.push('usage-bar-future')
          else if (unknownMarked) classes.push('usage-bar-unknown')
          else if (isSelected) classes.push('usage-bar-selected')
          else classes.push('usage-bar-normal')
          return (
            <g
              aria-label={barAriaLabel(bucket)}
              aria-pressed={onSelect ? isSelected : undefined}
              className={classes.join(' ')}
              key={bucket.key}
              onBlur={() =>
                setActiveKey((current) => (current === bucket.key ? undefined : current))
              }
              onClick={onSelect ? () => onSelect(bucket.key) : undefined}
              onFocus={() => setActiveKey(bucket.key)}
              onKeyDown={(event) => handleBarKeyDown(event, index)}
              onMouseEnter={() => setActiveKey(bucket.key)}
              onMouseLeave={() =>
                setActiveKey((current) => (current === bucket.key ? undefined : current))
              }
              ref={(element) => {
                barRefs.current[index] = element
              }}
              role={onSelect ? 'button' : 'img'}
              tabIndex={0}
            >
              {/* 全高透明命中区：零高度柱也能悬停/聚焦 */}
              <rect
                className="usage-bar-hit"
                height={plotHeight}
                width={slot}
                x={MARGIN.left + slot * index}
                y={MARGIN.top}
              />
              {bucket.future ? (
                <rect
                  className="usage-bar-rect"
                  height={4}
                  width={barWidth}
                  x={barX}
                  y={baselineY - 4}
                />
              ) : unknownMarked ? (
                <rect
                  className="usage-bar-rect"
                  height={6}
                  width={barWidth}
                  x={barX}
                  y={baselineY - 6}
                />
              ) : (
                <rect
                  className="usage-bar-rect"
                  height={Math.max(barHeight, bucket.totalTokens > 0 ? 2 : 0)}
                  width={barWidth}
                  x={barX}
                  y={baselineY - Math.max(barHeight, bucket.totalTokens > 0 ? 2 : 0)}
                />
              )}
            </g>
          )
        })}
        {buckets.map((bucket, index) => {
          const isLast = index === buckets.length - 1
          if (index % labelStride !== 0 && !isLast) return null
          return (
            <text
              className="usage-chart-tick"
              key={`${bucket.key}-label`}
              textAnchor="middle"
              x={MARGIN.left + slot * index + slot / 2}
              y={VIEW_HEIGHT - 8}
            >
              {axisLabel(bucket)}
            </text>
          )
        })}
      </svg>
      <ul className="usage-legend">
        <li>
          <span className="usage-legend-swatch usage-legend-total" aria-hidden="true" />
          {t('settings.usage.legendTotal')}
        </li>
        {onSelect ? (
          <li>
            <span className="usage-legend-swatch usage-legend-selected" aria-hidden="true" />
            {t('settings.usage.legendSelected')}
          </li>
        ) : null}
        {hasFuture ? (
          <li>
            <span className="usage-legend-swatch usage-legend-future" aria-hidden="true" />
            {t('settings.usage.futureLabel')}
          </li>
        ) : null}
        {hasUnknown ? (
          <li>
            <span className="usage-legend-swatch usage-legend-unknown" aria-hidden="true" />
            {t('settings.usage.legendUnknown')}
          </li>
        ) : null}
      </ul>
      <div aria-live="polite" className="usage-chart-detail">
        {activeBucket ? (
          <>
            <span className="usage-chart-detail-date">{bucketLabel(activeBucket)}</span>
            <span>
              {t('settings.usage.totalLabel')}: {metricText(activeBucket, 'total')}
            </span>
            <span>
              {t('settings.usage.inputLabel')}: {metricText(activeBucket, 'input')}
            </span>
            <span>
              {t('settings.usage.outputLabel')}: {metricText(activeBucket, 'output')}
            </span>
            <span>
              {t('settings.usage.requestsLabel')}:{' '}
              {formatTokenNumber(locale, activeBucket.requestCount)}
            </span>
            {completenessNotes(activeBucket).map((note) => (
              <span className="usage-chart-detail-note" key={note}>
                {note}
              </span>
            ))}
          </>
        ) : (
          <span className="usage-chart-detail-hint">
            {kind === 'week' && selectionHint
              ? `${t('settings.usage.focusHint')}；${selectionHint}`
              : t('settings.usage.focusHint')}
          </span>
        )}
      </div>
    </div>
  )
}

// 纵轴刻度取 1/2/5×10^k 的“整齐”上限，柱高按该上限缩放。
function niceCeil(value: number): number {
  if (value <= 0) return 1
  const exponent = Math.floor(Math.log10(value))
  const base = Math.pow(10, exponent)
  for (const multiple of [1, 2, 5, 10]) {
    if (value <= multiple * base) return multiple * base
  }
  return 10 * base
}
