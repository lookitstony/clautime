import { Card, CardContent } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { formatCompactNumber } from '@/lib/format'
import type { TodayStats } from '../../../../shared/types/live'

interface StatCardProps {
  label: string
  value: string | number
  accent?: boolean
}

function StatCard({ label, value, accent }: StatCardProps): React.JSX.Element {
  return (
    <Card className="bg-[var(--background-elevated)] border-[var(--surface-border)]">
      <CardContent className="px-4 py-3">
        <p className="text-[11px] font-normal uppercase tracking-wider text-[var(--text-muted)]">
          {label}
        </p>
        <p
          className={`mt-1 font-mono text-2xl font-bold ${accent ? 'text-[var(--accent)]' : 'text-[var(--text-primary)]'}`}
        >
          {value}
        </p>
      </CardContent>
    </Card>
  )
}

function StatCardSkeleton(): React.JSX.Element {
  return (
    <Card className="bg-[var(--background-elevated)] border-[var(--surface-border)]">
      <CardContent className="px-4 py-3">
        <Skeleton className="h-3 w-20 bg-[var(--surface-border)]" />
        <Skeleton className="mt-2 h-7 w-16 bg-[var(--surface-border)]" />
      </CardContent>
    </Card>
  )
}

interface LiveStatsBarProps {
  stats: TodayStats | undefined
  isLoading: boolean
}

export function LiveStatsBar({ stats, isLoading }: LiveStatsBarProps): React.JSX.Element {
  if (isLoading || !stats) {
    return (
      <div
        className="grid gap-3 p-4"
        style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))' }}
      >
        <StatCardSkeleton />
        <StatCardSkeleton />
        <StatCardSkeleton />
        <StatCardSkeleton />
        <StatCardSkeleton />
        <StatCardSkeleton />
      </div>
    )
  }

  return (
    <div
      className="grid gap-3 p-4"
      style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))' }}
    >
      <StatCard label="Human Hours" value={stats.humanHours} accent />
      <StatCard label="Agent Hours" value={stats.agentHours} />
      <StatCard label="Sessions" value={stats.totalSessions} />
      <StatCard label="Prompts" value={stats.totalPrompts.toLocaleString()} />
      <StatCard label="Commits" value={stats.totalCommits} />
      <StatCard label="Tokens" value={formatCompactNumber(stats.totalTokens)} />
    </div>
  )
}
