import { useId, useMemo } from 'react'
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid
} from 'recharts'
import { useChartColors } from '../chart-theme'
import type { WidgetProps } from '../widget-registry'
import { formatDateKey } from '@/lib/format'

export default function PromptsPerDayChart({ sessionData }: WidgetProps): React.JSX.Element {
  const { accent, mutedColor, gridColor, textColor } = useChartColors()
  const gradientId = useId()

  const data = useMemo(() => {
    const map = new Map<string, number>()
    for (const s of sessionData) {
      const date = s.startedAt.slice(0, 10)
      map.set(date, (map.get(date) ?? 0) + s.promptCount)
    }
    return [...map.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, count]) => ({
        date: formatDateKey(date),
        prompts: count
      }))
  }, [sessionData])

  if (data.length === 0)
    return (
      <div className="flex h-full items-center justify-center text-sm text-[var(--text-muted)]">
        No data for this period
      </div>
    )

  return (
    <ResponsiveContainer width="100%" height="100%">
      <AreaChart data={data} margin={{ top: 5, right: 10, left: 0, bottom: 5 }}>
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor={accent} stopOpacity={0.3} />
            <stop offset="95%" stopColor={accent} stopOpacity={0} />
          </linearGradient>
        </defs>
        <CartesianGrid strokeDasharray="3 3" stroke={gridColor} />
        <XAxis dataKey="date" tick={{ fontSize: 11, fill: mutedColor }} />
        <YAxis tick={{ fontSize: 11, fill: mutedColor }} />
        <Tooltip
          contentStyle={{
            backgroundColor: 'var(--background-elevated)',
            border: '1px solid var(--surface-border)',
            color: textColor,
            fontSize: 12
          }}
          itemStyle={{ color: textColor }}
          labelStyle={{ color: textColor }}
        />
        <Area type="monotone" dataKey="prompts" stroke={accent} fill={`url(#${gradientId})`} />
      </AreaChart>
    </ResponsiveContainer>
  )
}
