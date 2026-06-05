import { useMemo } from 'react'
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
  Legend
} from 'recharts'
import { useChartColors } from '../chart-theme'
import type { WidgetProps } from '../widget-registry'
import { formatDateKey } from '@/lib/format'

function EmptyMessage(): React.JSX.Element {
  return (
    <div className="flex h-full items-center justify-center text-sm text-[var(--text-muted)]">
      No data for this period
    </div>
  )
}

export default function DailyHoursChart({ sessionData }: WidgetProps): React.JSX.Element {
  const { textColor, mutedColor, gridColor, palette } = useChartColors()

  const { chartData, projectNames } = useMemo(() => {
    const byDateProject = new Map<string, Map<string, number>>()
    const projectTotals = new Map<string, number>()

    for (const s of sessionData) {
      const date = s.startedAt.slice(0, 10)
      if (!byDateProject.has(date)) byDateProject.set(date, new Map())
      const dayMap = byDateProject.get(date)!
      dayMap.set(s.projectName, (dayMap.get(s.projectName) ?? 0) + s.durationMinutes / 60)
      projectTotals.set(s.projectName, (projectTotals.get(s.projectName) ?? 0) + s.durationMinutes)
    }

    const sorted = [...projectTotals.entries()].sort((a, b) => b[1] - a[1])
    const topProjects = sorted.slice(0, 6).map(([n]) => n)
    const hasOther = sorted.length > 6
    const names = hasOther ? [...topProjects, 'Other'] : topProjects

    const data = [...byDateProject.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, dayMap]) => {
        const entry: Record<string, string | number> = { date: formatDateKey(date) }
        for (const p of topProjects) {
          entry[p] = Math.round((dayMap.get(p) ?? 0) * 100) / 100
        }
        if (hasOther) {
          let other = 0
          for (const [p, v] of dayMap) {
            if (!topProjects.includes(p)) other += v
          }
          entry['Other'] = Math.round(other * 100) / 100
        }
        return entry
      })

    return { chartData: data, projectNames: names }
  }, [sessionData])

  if (chartData.length === 0) return <EmptyMessage />

  return (
    <ResponsiveContainer width="100%" height="100%">
      <BarChart data={chartData} margin={{ top: 5, right: 10, left: 0, bottom: 5 }}>
        <CartesianGrid strokeDasharray="3 3" stroke={gridColor} />
        <XAxis dataKey="date" tick={{ fontSize: 11, fill: mutedColor }} />
        <YAxis
          tick={{ fontSize: 11, fill: mutedColor }}
          label={{
            value: 'Hours',
            angle: -90,
            position: 'insideLeft',
            style: { fontSize: 11, fill: mutedColor }
          }}
        />
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
        <Legend wrapperStyle={{ fontSize: 11 }} />
        {projectNames.map((name, i) => (
          <Bar key={name} dataKey={name} stackId="hours" fill={palette[i % palette.length]} />
        ))}
      </BarChart>
    </ResponsiveContainer>
  )
}
