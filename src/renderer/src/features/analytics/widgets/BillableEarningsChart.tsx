import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from 'recharts'
import { useChartColors } from '../chart-theme'
import type { WidgetProps } from '../widget-registry'

export default function BillableEarningsChart({ summaryData }: WidgetProps): React.JSX.Element {
  const { accent, textColor, mutedColor, gridColor } = useChartColors()

  const data = summaryData?.billedByClient ?? []

  if (data.length === 0)
    return (
      <div className="flex h-full items-center justify-center text-sm text-[var(--text-muted)]">
        No billable data
      </div>
    )

  const chartData = data.map((d) => ({
    clientName: d.clientName,
    cost: Math.round(d.cost * 100) / 100,
    hours: d.hours,
    rate: d.rate
  }))

  return (
    <ResponsiveContainer width="100%" height="100%">
      <BarChart data={chartData} margin={{ top: 5, right: 10, left: 0, bottom: 5 }}>
        <CartesianGrid strokeDasharray="3 3" stroke={gridColor} />
        <XAxis dataKey="clientName" tick={{ fontSize: 11, fill: mutedColor }} />
        <YAxis tick={{ fontSize: 11, fill: mutedColor }} tickFormatter={(v) => `$${v}`} />
        <Tooltip
          contentStyle={{
            backgroundColor: 'var(--background-elevated)',
            border: '1px solid var(--surface-border)',
            color: textColor,
            fontSize: 12
          }}
          content={({ active, payload }) => {
            if (!active || !payload?.[0]) return null
            const { hours, rate, cost } = payload[0].payload as {
              hours: number
              rate: number
              cost: number
            }
            return (
              <div className="rounded border border-[var(--surface-border)] bg-[var(--background-elevated)] px-2 py-1 text-xs text-[var(--text-primary)]">
                {hours.toFixed(1)}h &times; ${rate}/h = ${cost.toFixed(2)}
              </div>
            )
          }}
        />
        <Bar dataKey="cost" fill={accent} radius={[4, 4, 0, 0]} />
      </BarChart>
    </ResponsiveContainer>
  )
}
