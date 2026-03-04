import { useSessions, useSessionStats } from '@/features/sessions/use-sessions'
import { formatRelativeTime } from '@/lib/format'
import { useMutation, useQueryClient } from '@tanstack/react-query'

export function StatusBar(): React.JSX.Element {
  const { data: sessions } = useSessions()
  const stats = useSessionStats(sessions)
  const queryClient = useQueryClient()

  const projectCount = sessions
    ? new Set(sessions.map((s) => s.projectPath)).size
    : 0

  const lastScan = sessions && sessions.length > 0 ? 'recently' : 'never'

  const resetMutation = useMutation({
    mutationFn: async () => {
      await window.api.sessions.reset()
      await window.api.settings.set('setup_complete', '')
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['settings'] })
      queryClient.invalidateQueries({ queryKey: ['sessions'] })
    }
  })

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
        {import.meta.env.DEV && (
          <button
            onClick={() => resetMutation.mutate()}
            className="rounded bg-red-900/50 px-1.5 text-red-300 hover:bg-red-900/80"
          >
            DEV: Reset Wizard
          </button>
        )}
      </div>
      <div className="font-mono text-[var(--accent)]">
        <span>{stats.todayTotal} today</span>
      </div>
    </footer>
  )
}
