import { useSessions, useSessionStats } from '@/features/sessions/use-sessions'
import { formatRelativeTime } from '@/lib/format'

export function StatusBar(): React.JSX.Element {
  const { data: sessions } = useSessions()
  const stats = useSessionStats(sessions)

  const projectCount = sessions
    ? new Set(sessions.map((s) => s.projectPath)).size
    : 0

  // Last scan time is stored in settings; for now show based on data availability
  const lastScan = sessions && sessions.length > 0 ? 'recently' : 'never'

  return (
    <footer
      className="flex h-6 shrink-0 items-center justify-between border-t border-[var(--surface-border)] bg-[var(--background-secondary)] px-3"
      style={{ fontSize: '11px' }}
      role="status"
      aria-live="polite"
    >
      <div className="flex items-center gap-3 text-[var(--text-muted)]">
        <span>Watching {projectCount} projects</span>
        <span>Last scan: {lastScan}</span>
      </div>
      <div className="font-mono text-[var(--accent)]">
        <span>{stats.todayTotal} today</span>
      </div>
    </footer>
  )
}
