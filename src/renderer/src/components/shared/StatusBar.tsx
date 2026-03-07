import { useState, useEffect } from 'react'
import { WifiOff } from 'lucide-react'
import { useTodayStats } from '@/features/live/use-live'
import { useSessions, useSessionStats } from '@/features/sessions/use-sessions'
import { useClients } from '@/features/clients/use-clients'
import { useSessionIdsWithCommits } from '@/features/git/use-git'

function formatTokens(n: number): string {
  if (n >= 999_500) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`
  return String(n)
}

export function StatusBar(): React.JSX.Element {
  const { data: todayStats } = useTodayStats()
  const { data: allSessions } = useSessions()
  const { data: clients } = useClients()
  const { data: sessionIdsWithCommits } = useSessionIdsWithCommits()
  const allStats = useSessionStats(allSessions, clients, sessionIdsWithCommits)
  const [showAllTime, setShowAllTime] = useState(false)
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

  const sessions = showAllTime ? allStats.totalSessions : (todayStats?.totalSessions ?? 0)
  const prompts = showAllTime ? allStats.totalPrompts : (todayStats?.totalPrompts ?? 0)
  const tokens = showAllTime ? allStats.totalTokens : (todayStats?.totalTokens ?? 0)
  const commits = showAllTime ? allStats.commitSessions : (todayStats?.totalCommits ?? 0)
  const hours = showAllTime ? allStats.humanHours : (todayStats?.humanHours ?? '0h')
  const label = showAllTime ? 'all time' : 'today'

  return (
    <footer
      className="flex h-6 shrink-0 items-center justify-between border-t border-[var(--surface-border)] bg-[var(--background-secondary)] px-3 cursor-pointer select-none outline-none focus-visible:ring-1 focus-visible:ring-[var(--accent)]"
      style={{ fontSize: '11px' }}
      role="status"
      aria-live="polite"
      tabIndex={0}
      onClick={() => setShowAllTime((v) => !v)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          setShowAllTime((v) => !v)
        }
      }}
    >
      <div className="flex items-center gap-3 text-[var(--text-muted)]">
        <span className="tabular-nums">
          {sessions} session{sessions !== 1 ? 's' : ''}
          {' · '}
          {prompts} prompt{prompts !== 1 ? 's' : ''}
          {' · '}
          {formatTokens(tokens)} tokens
          {' · '}
          {commits} commit{commits !== 1 ? 's' : ''}
        </span>
        {!isOnline && (
          <span className="flex items-center gap-1 text-amber-400">
            <WifiOff size={10} />
            Offline
          </span>
        )}
      </div>
      <span className="font-mono text-[var(--accent)] hover:brightness-125">
        {hours} {label}
      </span>
    </footer>
  )
}
