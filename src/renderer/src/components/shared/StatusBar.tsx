interface StatusBarProps {
  watchCount?: number
  lastScan?: string
  dailyTotal?: string
}

export function StatusBar({
  watchCount = 0,
  lastScan = 'never',
  dailyTotal = '0h 0m'
}: StatusBarProps): React.JSX.Element {
  return (
    <footer
      className="flex h-6 shrink-0 items-center justify-between border-t border-[var(--surface-border)] bg-[var(--background-secondary)] px-3"
      style={{ fontSize: '11px' }}
    >
      <div className="flex items-center gap-3 text-[var(--text-muted)]">
        <span>Watching {watchCount} projects</span>
        <span>Last scan: {lastScan}</span>
      </div>
      <div className="text-[var(--text-muted)]">
        <span>{dailyTotal} today</span>
      </div>
    </footer>
  )
}
