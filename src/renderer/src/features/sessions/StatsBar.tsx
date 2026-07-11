import { formatCompactNumber } from '@/lib/format'
import {
  ConfigurableStatsBar,
  type StatCardDef
} from '@/components/shared/ConfigurableStatsBar'

interface StatsBarProps {
  humanHours: string
  totalHours: string
  totalSessions: number
  totalPrompts: number
  totalTokens: number
  clientCount: number
  commitSessions: number
  estimatedCost: string | null
  earnings: string | null
  isLoading: boolean
}

export function StatsBar({
  humanHours,
  totalHours,
  totalSessions,
  totalPrompts,
  totalTokens,
  clientCount,
  commitSessions,
  estimatedCost,
  earnings,
  isLoading
}: StatsBarProps): React.JSX.Element {
  const defs: StatCardDef[] = [
    { id: 'human-hours', label: 'Human Hours', value: humanHours, accent: true },
    {
      id: 'earnings',
      label: 'Earned',
      value: earnings ?? '',
      accent: true,
      available: earnings != null
    },
    { id: 'agent-hours', label: 'Agent Hours', value: totalHours },
    { id: 'sessions', label: 'Sessions', value: totalSessions },
    { id: 'prompts', label: 'Prompts', value: totalPrompts.toLocaleString() },
    { id: 'commits', label: 'Commits', value: commitSessions, available: commitSessions > 0 },
    {
      id: 'tokens',
      label: 'Tokens',
      value: formatCompactNumber(totalTokens),
      available: totalTokens > 0
    },
    {
      id: 'est-cost',
      label: 'Est. API Cost',
      value: estimatedCost ?? '',
      available: estimatedCost != null
    },
    { id: 'clients', label: 'Clients', value: clientCount, available: clientCount > 0 }
  ]

  return (
    <ConfigurableStatsBar storageKey="sessions_statsbar_layout" defs={defs} isLoading={isLoading} />
  )
}
