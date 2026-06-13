import { formatCompactNumber } from '@/lib/format'
import {
  ConfigurableStatsBar,
  type StatCardDef
} from '@/components/shared/ConfigurableStatsBar'
import type { TodayStats } from '../../../../shared/types/live'

interface LiveStatsBarProps {
  stats: TodayStats | undefined
  /** Estimated API cost for today's usage, pre-formatted (null hides the card) */
  estimatedCost: string | null
  isLoading: boolean
}

export function LiveStatsBar({
  stats,
  estimatedCost,
  isLoading
}: LiveStatsBarProps): React.JSX.Element {
  const defs: StatCardDef[] = stats
    ? [
        { id: 'human-hours', label: 'Human Hours', value: stats.humanHours, accent: true },
        { id: 'agent-hours', label: 'Agent Hours', value: stats.agentHours },
        { id: 'sessions', label: 'Sessions', value: stats.totalSessions },
        { id: 'prompts', label: 'Prompts', value: stats.totalPrompts.toLocaleString() },
        { id: 'commits', label: 'Commits', value: stats.totalCommits },
        { id: 'tokens', label: 'Tokens', value: formatCompactNumber(stats.totalTokens) },
        {
          id: 'est-cost',
          label: 'Est. Cost Today',
          value: estimatedCost ?? '',
          available: estimatedCost != null
        }
      ]
    : []

  return (
    <ConfigurableStatsBar
      storageKey="live_statsbar_layout"
      defs={defs}
      isLoading={isLoading || !stats}
      skeletonCount={6}
      minCardWidth={140}
    />
  )
}
