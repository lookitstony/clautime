import { useMemo } from 'react'
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, Legend } from 'recharts'
import { useChartColors } from '../chart-theme'
import type { WidgetProps } from '../widget-registry'
import { formatDateKey } from '@/lib/format'

function formatTokenAxis(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
  if (value >= 1_000) return `${(value / 1_000).toFixed(0)}K`
  return String(value)
}

export default function TokenUsageChart({ sessionData }: WidgetProps): React.JSX.Element {
  const { textColor, mutedColor, gridColor, palette } = useChartColors()

  const data = useMemo(() => {
    const map = new Map<string, { input: number; output: number }>()
    for (const s of sessionData) {
      const date = s.startedAt.slice(0, 10)
      const entry = map.get(date) ?? { input: 0, output: 0 }
      entry.input += s.inputTokens
      entry.output += s.outputTokens
      map.set(date, entry)
    }
    return [...map.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, { input, output }]) => ({
        date: formatDateKey(date),
        Input: input,
        Output: output
      }))
  }, [sessionData])

  if (data.length === 0) return <div className="flex h-full items-center justify-center text-sm text-[var(--text-muted)]">No data for this period</div>

  return (
    <ResponsiveContainer width="100%" height="100%">
      <BarChart data={data} margin={{ top: 5, right: 10, left: 0, bottom: 5 }}>
        <CartesianGrid strokeDasharray="3 3" stroke={gridColor} />
        <XAxis dataKey="date" tick={{ fontSize: 11, fill: mutedColor }} />
        <YAxis tickFormatter={formatTokenAxis} tick={{ fontSize: 11, fill: mutedColor }} />
        <Tooltip
          contentStyle={{ backgroundColor: 'var(--background-elevated)', border: '1px solid var(--surface-border)', color: textColor, fontSize: 12 }}
          itemStyle={{ color: textColor }}
          labelStyle={{ color: textColor }}
          formatter={(value: number) => [formatTokenAxis(value), undefined]}
        />
        <Legend wrapperStyle={{ fontSize: 11 }} />
        <Bar dataKey="Input" fill={palette[0]} />
        <Bar dataKey="Output" fill={palette[1]} />
      </BarChart>
    </ResponsiveContainer>
  )
}
