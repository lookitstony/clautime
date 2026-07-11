import { formatUsd } from '@/lib/format'
import type { WidgetProps } from '../widget-registry'

/**
 * Headline "Earned" for the filtered period: billable human hours × effective
 * (project-or-client) rate. Mirrors the Earned stat on Sessions and Live.
 */
export default function EarningsCard({ summaryData }: WidgetProps): React.JSX.Element {
  const earned = summaryData?.totalEarned ?? 0
  const hours = summaryData ? summaryData.totalDurationMinutes / 60 : 0

  return (
    <div className="flex h-full flex-col items-center justify-center gap-1">
      <span className="text-[11px] font-normal uppercase tracking-wider text-[var(--text-muted)]">
        Earned this period
      </span>
      <span className="font-mono text-4xl font-bold text-[var(--accent)]">{formatUsd(earned)}</span>
      <span className="text-[12px] text-[var(--text-muted)]">
        across {hours.toFixed(1)} agent hours
      </span>
    </div>
  )
}
