import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { WidgetProps } from '../widget-registry'
import { getModelPricing, estimateCostUsd } from '../../../../../shared/pricing'

function formatUsd(value: number): string {
  return value.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 2
  })
}

function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`
  return String(value)
}

export default function EstimatedCostChart({
  sessionData,
  filters
}: WidgetProps): React.JSX.Element {
  // Prefer the page's active filters; fall back to a range derived from session data
  const usageFilters = useMemo(() => {
    if (filters) {
      return {
        startDate: filters.startDate,
        endDate: filters.endDate,
        ...(filters.clientId != null ? { clientId: filters.clientId } : {}),
        ...(filters.projectId != null ? { projectId: filters.projectId } : {})
      }
    }
    if (sessionData.length === 0) return null
    let startDate = sessionData[0].startedAt
    let endDate = sessionData[0].endedAt
    for (const s of sessionData) {
      if (s.startedAt < startDate) startDate = s.startedAt
      if (s.endedAt > endDate) endDate = s.endedAt
    }
    return { startDate, endDate }
  }, [filters, sessionData])

  const { data: usage, isLoading } = useQuery({
    queryKey: ['sessions', 'modelUsage', usageFilters],
    queryFn: async () => {
      if (!usageFilters) return []
      const r = await window.api.sessions.getModelUsage(usageFilters)
      return r.success ? r.data : []
    },
    enabled: !!usageFilters
  })

  const rows = useMemo(() => {
    if (!usage) return []
    return usage
      .map((u) => {
        const pricing = getModelPricing(u.model)
        return {
          model: u.model,
          displayName: pricing.displayName,
          totalTokens:
            u.inputTokens + u.outputTokens + u.cacheCreationInputTokens + u.cacheReadInputTokens,
          cost: estimateCostUsd(u.model, u)
        }
      })
      .sort((a, b) => b.cost - a.cost)
  }, [usage])

  const totalCost = rows.reduce((s, r) => s + r.cost, 0)

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-[var(--text-muted)]">
        Loading…
      </div>
    )
  }

  if (rows.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-1 text-sm text-[var(--text-muted)]">
        <span>No model usage data for this period</span>
        <span className="text-xs">Run a rescan or rebuild from Settings to populate costs</span>
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-col items-center pb-2">
        <span className="text-3xl font-bold text-[var(--accent)]">{formatUsd(totalCost)}</span>
        <span className="text-[11px] text-[var(--text-muted)]">
          Estimated API cost — what this usage would bill without a subscription
        </span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-left text-[var(--text-muted)]">
              <th className="py-1 font-medium">Model</th>
              <th className="py-1 text-right font-medium">Tokens</th>
              <th className="py-1 text-right font-medium">Cost</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.model} className="border-t border-[var(--surface-border)]">
                <td className="py-1 text-[var(--text-primary)]" title={r.model}>
                  {r.displayName}
                </td>
                <td className="py-1 text-right text-[var(--text-muted)]">
                  {formatTokens(r.totalTokens)}
                </td>
                <td className="py-1 text-right text-[var(--text-primary)]">{formatUsd(r.cost)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="pt-1 text-center text-[10px] text-[var(--text-muted)]">
        Includes cache writes (1.25×) and cache reads (0.1×) at published API rates
      </div>
    </div>
  )
}
