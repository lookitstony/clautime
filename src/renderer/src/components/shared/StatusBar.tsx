import { useSessions, useSessionStats } from '@/features/sessions/use-sessions'
import { useClients } from '@/features/clients/use-clients'
import { useProjects } from '@/features/clients/use-projects'
import { useMutation, useQueryClient } from '@tanstack/react-query'

export function StatusBar(): React.JSX.Element {
  const { data: sessions } = useSessions()
  const { data: clients } = useClients()
  const { data: projects } = useProjects()
  const stats = useSessionStats(sessions, clients, projects)
  const queryClient = useQueryClient()

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

  const projectInfo = stats.clientCount > 0
    ? `${stats.clientCount} client${stats.clientCount !== 1 ? 's' : ''} · ${stats.projectCount} project${stats.projectCount !== 1 ? 's' : ''}${stats.unassignedCount > 0 ? ` · ${stats.unassignedCount} unassigned` : ''}`
    : `${stats.totalSessions} session${stats.totalSessions !== 1 ? 's' : ''}`

  return (
    <footer
      className="flex h-6 shrink-0 items-center justify-between border-t border-[var(--surface-border)] bg-[var(--background-secondary)] px-3"
      style={{ fontSize: '11px' }}
      role="status"
      aria-live="polite"
    >
      <div className="flex items-center gap-3 text-[var(--text-muted)]">
        <span>{projectInfo}</span>
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
