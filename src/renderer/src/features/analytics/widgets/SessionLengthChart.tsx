import { useMemo } from 'react'
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from 'recharts'
import { useChartColors } from '../chart-theme'
import type { WidgetProps } from '../widget-registry'

const BUCKETS = [
  { label: '0-15m', min: 0, max: 15 },
  { label: '15-30m', min: 15, max: 30 },
  { label: '30-60m', min: 30, max: 60 },
  { label: '1-2h', min: 60, max: 120 },
  { label: '2-4h', min: 120, max: 240 },
  { label: '4h+', min: 240, max: Infinity }
]

export default function SessionLengthChart({ sessionData }: WidgetProps): React.JSX.Element {
  const { accent, textColor, mutedColor, gridColor } = useChartColors()

  const data = useMemo(() => {
    const counts = BUCKETS.map((b) => ({ label: b.label, count: 0 }))
    for (const s of sessionData) {
      const idx = BUCKETS.findIndex((b) => s.durationMinutes >= b.min && s.durationMinutes < b.max)
      if (idx >= 0) counts[idx].count++
    }
    return counts
  }, [sessionData])

  if (sessionData.length === 0) return <div className="flex h-full items-center justify-center text-sm text-[var(--text-muted)]">No data for this period</div>

  return (
    <ResponsiveContainer width="100%" height="100%">
      <BarChart data={data} margin={{ top: 5, right: 10, left: 0, bottom: 5 }}>
        <CartesianGrid strokeDasharray="3 3" stroke={gridColor} />
        <XAxis dataKey="label" tick={{ fontSize: 11, fill: mutedColor }} />
        <YAxis tick={{ fontSize: 11, fill: mutedColor }} label={{ value: 'Sessions', angle: -90, position: 'insideLeft', style: { fontSize: 11, fill: mutedColor } }} />
        <Tooltip contentStyle={{ backgroundColor: 'var(--background-elevated)', border: '1px solid var(--surface-border)', color: textColor, fontSize: 12 }} itemStyle={{ color: textColor }} labelStyle={{ color: textColor }} />
        <Bar dataKey="count" fill={accent} radius={[4, 4, 0, 0]} />
      </BarChart>
    </ResponsiveContainer>
  )
}
