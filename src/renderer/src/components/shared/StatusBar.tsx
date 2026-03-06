import { useState, useEffect } from 'react'
import { WifiOff } from 'lucide-react'
import { useTodayStats } from '@/features/live/use-live'
import { useSessions, useSessionStats } from '@/features/sessions/use-sessions'
import { useClients } from '@/features/clients/use-clients'

export function StatusBar(): React.JSX.Element {
  const { data: todayStats } = useTodayStats()
  const { data: allSessions } = useSessions()
  const { data: clients } = useClients()
  const allStats = useSessionStats(allSessions, clients)
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

  const statusText = todayStats
    ? `${todayStats.totalSessions} session${todayStats.totalSessions !== 1 ? 's' : ''} today`
    : ''

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
      </div>
      <button
        type="button"
        onClick={() => setShowAllTime((v) => !v)}
        className="font-mono text-[var(--accent)] hover:brightness-125 cursor-pointer"
      >
        {showAllTime
          ? `${allStats.humanHours} all time`
          : `${todayStats?.humanHours ?? '0h'} today`}
      </button>
    </footer>
  )
}
