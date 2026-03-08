import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, Legend } from 'recharts'
import { useChartColors } from '../chart-theme'
import type { WidgetProps } from '../widget-registry'
import { formatDateKey } from '@/lib/format'

function EmptyMessage(): React.JSX.Element {
  return <div className="flex h-full items-center justify-center text-sm text-[var(--text-muted)]">No data for this period</div>
}

export default function WorkVsIdleChart({ sessionData }: WidgetProps): React.JSX.Element {
  const { textColor, mutedColor, gridColor } = useChartColors()

  // Derive date range from session data
  const dateRange = useMemo(() => {
    if (sessionData.length === 0) return null
    const sorted = [...sessionData].sort((a, b) => a.startedAt.localeCompare(b.startedAt))
    return { startDate: sorted[0].startedAt, endDate: sorted[sorted.length - 1].endedAt }
  }, [sessionData])

  const { data: breakdown } = useQuery({
    queryKey: ['sessions', 'timeBreakdown', dateRange?.startDate, dateRange?.endDate],
    queryFn: async () => {
      if (!dateRange) return []
      const r = await window.api.sessions.getTimeBreakdown(dateRange.startDate, dateRange.endDate)
      return r.success ? r.data : []
    },
    enabled: !!dateRange
  })

  const { chartData, totals } = useMemo(() => {
    if (!breakdown || breakdown.length === 0) return { chartData: [], totals: null }

    const data = breakdown.map((d) => ({
      date: formatDateKey(d.date),
      ai: Math.round((d.workMinutes / 60) * 100) / 100,
      human: Math.round((d.idleMinutes / 60) * 100) / 100,
      total: Math.round((d.totalMinutes / 60) * 100) / 100
    }))

    const totalAi = breakdown.reduce((s, d) => s + d.workMinutes, 0)
    const totalHuman = breakdown.reduce((s, d) => s + d.idleMinutes, 0)
    const totalTracked = breakdown.reduce((s, d) => s + d.totalMinutes, 0)

    return {
      chartData: data,
      totals: {
        ai: (totalAi / 60).toFixed(1),
        human: (totalHuman / 60).toFixed(1),
        total: (totalTracked / 60).toFixed(1),
        humanPct: totalTracked > 0 ? Math.round((totalHuman / totalTracked) * 100) : 0
      }
    }
  }, [breakdown])

  if (chartData.length === 0) return <EmptyMessage />

  return (
    <div className="flex h-full flex-col">
      <div className="min-h-0 flex-1">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={chartData} margin={{ top: 5, right: 10, left: 0, bottom: 5 }}>
            <CartesianGrid strokeDasharray="3 3" stroke={gridColor} />
            <XAxis dataKey="date" tick={{ fontSize: 11, fill: mutedColor }} />
            <YAxis
              tick={{ fontSize: 11, fill: mutedColor }}
              label={{ value: 'Hours', angle: -90, position: 'insideLeft', style: { fontSize: 11, fill: mutedColor } }}
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
              formatter={(value: number, name: string) => [
                `${value}h`,
                name === 'ai' ? 'AI processing' : 'Human time'
              ]}
            />
            <Legend
              wrapperStyle={{ fontSize: 11 }}
              formatter={(value: string) => value === 'ai' ? 'AI processing' : 'Human time'}
            />
            <Bar dataKey="ai" stackId="time" fill="var(--accent)" name="ai" />
            <Bar dataKey="human" stackId="time" fill="#8b5cf6" fillOpacity={0.6} name="human" />
          </BarChart>
        </ResponsiveContainer>
      </div>
      {totals && (
        <div className="flex justify-center gap-4 pt-1 text-[10px] text-[var(--text-muted)]">
          <span>Total: <strong className="text-[var(--text-primary)]">{totals.total}h</strong></span>
          <span>AI: <strong style={{ color: 'var(--accent)' }}>{totals.ai}h</strong></span>
          <span>Human: <strong style={{ color: '#8b5cf6' }}>{totals.human}h</strong> ({totals.humanPct}%)</span>
        </div>
      )}
    </div>
  )
}
