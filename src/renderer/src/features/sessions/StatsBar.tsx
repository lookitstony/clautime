import { Card, CardContent } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { formatCompactNumber } from '@/lib/format'

interface StatsBarProps {
  humanHours: string
  totalHours: string
  totalSessions: number
  totalPrompts: number
  totalTokens: number
  clientCount: number
  isLoading: boolean
}

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

export function StatsBar({
  humanHours,
  totalHours,
  totalSessions,
  totalPrompts,
  totalTokens,
  clientCount,
  isLoading
}: StatsBarProps): React.JSX.Element {
  if (isLoading) {
    return (
      <div
        className="grid gap-3 p-4"
        style={{
          gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))'
        }}
      >
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
      style={{
        gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))'
      }}
    >
      <StatCard label="Human Hours" value={humanHours} accent />
      <StatCard label="Agent Hours" value={totalHours} />
      <StatCard label="Sessions" value={totalSessions} />
      <StatCard label="Prompts" value={totalPrompts.toLocaleString()} />
      {totalTokens > 0 && <StatCard label="Tokens" value={formatCompactNumber(totalTokens)} />}
      {clientCount > 0 && <StatCard label="Clients" value={clientCount} />}
    </div>
  )
}
