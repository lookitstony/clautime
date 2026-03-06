import { useMemo } from 'react'
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from 'recharts'
import { useChartColors } from '../chart-theme'
import type { WidgetProps } from '../widget-registry'

const HOUR_LABELS = [
  '12am', '1am', '2am', '3am', '4am', '5am', '6am', '7am', '8am', '9am', '10am', '11am',
  '12pm', '1pm', '2pm', '3pm', '4pm', '5pm', '6pm', '7pm', '8pm', '9pm', '10pm', '11pm'
]

export default function PeakHoursChart({ sessionData }: WidgetProps): React.JSX.Element {
  const { accent, textColor, mutedColor, gridColor } = useChartColors()

  const data = useMemo(() => {
    const counts = Array.from({ length: 24 }, (_, i) => ({ hour: HOUR_LABELS[i], sessions: 0 }))
    for (const s of sessionData) {
      const h = new Date(s.startedAt).getHours()
      counts[h].sessions++
    }
    // Filter to only hours with data to avoid cramped display
    const hasData = counts.filter((c) => c.sessions > 0)
    return hasData.length > 0 ? hasData : counts
  }, [sessionData])

  if (sessionData.length === 0) return <div className="flex h-full items-center justify-center text-sm text-[var(--text-muted)]">No data for this period</div>

  return (
    <ResponsiveContainer width="100%" height="100%">
      <BarChart data={data} layout="vertical" margin={{ top: 5, right: 10, left: 10, bottom: 5 }}>
        <CartesianGrid strokeDasharray="3 3" stroke={gridColor} />
        <XAxis type="number" tick={{ fontSize: 11, fill: mutedColor }} />
        <YAxis dataKey="hour" type="category" tick={{ fontSize: 10, fill: mutedColor }} width={40} />
        <Tooltip contentStyle={{ backgroundColor: 'var(--background-elevated)', border: '1px solid var(--surface-border)', color: textColor, fontSize: 12 }} itemStyle={{ color: textColor }} labelStyle={{ color: textColor }} />
        <Bar dataKey="sessions" fill={accent} radius={[0, 4, 4, 0]} />
      </BarChart>
    </ResponsiveContainer>
  )
}
