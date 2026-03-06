import { useMemo } from 'react'
import { PieChart, Pie, Cell, Tooltip, ResponsiveContainer, Legend } from 'recharts'
import { useChartColors } from '../chart-theme'
import type { WidgetProps } from '../widget-registry'

export default function HoursByClientChart({ sessionData }: WidgetProps): React.JSX.Element {
  const { textColor, palette } = useChartColors()

  const data = useMemo(() => {
    const map = new Map<string, number>()
    for (const s of sessionData) {
      const client = s.clientName ?? 'Unassigned'
      map.set(client, (map.get(client) ?? 0) + s.durationMinutes / 60)
    }
    return [...map.entries()]
      .map(([name, hours]) => ({ name, hours: Math.round(hours * 100) / 100 }))
      .sort((a, b) => b.hours - a.hours)
  }, [sessionData])

  if (data.length === 0) return <div className="flex h-full items-center justify-center text-sm text-[var(--text-muted)]">No data for this period</div>

  const total = data.reduce((s, d) => s + d.hours, 0)

  return (
    <ResponsiveContainer width="100%" height="100%">
      <PieChart>
        <Pie data={data} dataKey="hours" nameKey="name" cx="50%" cy="45%" innerRadius={60} outerRadius={90} paddingAngle={2}>
          {data.map((_, i) => (
            <Cell key={i} fill={palette[i % palette.length]} />
          ))}
        </Pie>
        <Tooltip
          contentStyle={{ backgroundColor: 'var(--background-elevated)', border: '1px solid var(--surface-border)', color: textColor, fontSize: 12 }}
          itemStyle={{ color: textColor }}
          labelStyle={{ color: textColor }}
          formatter={(value: number) => {
            const pct = total > 0 ? ((value / total) * 100).toFixed(0) : '0'
            return [`${value.toFixed(1)}h (${pct}%)`, 'Hours']
          }}
        />
        <Legend wrapperStyle={{ fontSize: 11 }} />
      </PieChart>
    </ResponsiveContainer>
  )
}
