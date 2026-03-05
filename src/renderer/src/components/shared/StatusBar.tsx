import { useState, useEffect } from 'react'
import { useSessions, useSessionStats } from '@/features/sessions/use-sessions'
import { useClients } from '@/features/clients/use-clients'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Wifi, WifiOff } from 'lucide-react'

export function StatusBar(): React.JSX.Element {
  const { data: sessions } = useSessions()
  const { data: clients } = useClients()
  const stats = useSessionStats(sessions, clients)
  const queryClient = useQueryClient()
  const [isOnline, setIsOnline] = useState(navigator.onLine)

  useEffect(() => {
    const handleOnline = () => setIsOnline(true)
    const handleOffline = () => setIsOnline(false)
    window.addEventListener('online', handleOnline)
    window.addEventListener('offline', handleOffline)
    return () => {
      window.removeEventListener('online', handleOnline)
      window.removeEventListener('offline', handleOffline)
    }
  }, [])

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

  const statusText = stats.clientCount > 0
    ? `${stats.clientCount} client${stats.clientCount !== 1 ? 's' : ''} · ${stats.totalSessions} session${stats.totalSessions !== 1 ? 's' : ''}`
    : `${stats.totalSessions} session${stats.totalSessions !== 1 ? 's' : ''}`

  return (
    <footer
      className="flex h-6 shrink-0 items-center justify-between border-t border-[var(--surface-border)] bg-[var(--background-secondary)] px-3"
      style={{ fontSize: '11px' }}
      role="status"
      aria-live="polite"
    >
      <div className="flex items-center gap-3 text-[var(--text-muted)]">
        <span>{statusText}</span>
        {!isOnline && (
          <span className="flex items-center gap-1 text-amber-400">
            <WifiOff size={10} />
            Offline
          </span>
        )}
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
        <span>{stats.humanHours} total</span>
      </div>
    </footer>
  )
}
