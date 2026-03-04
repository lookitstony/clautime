import { useCallback, type KeyboardEvent } from 'react'
import { Badge } from '@/components/ui/badge'
import { formatTimeRange, formatDuration } from '@/lib/format'
import { cn } from '@/lib/utils'
import type { Session } from '../../../../shared/types/session'

interface SessionRowProps {
  session: Session
  projectColor: string
  isSelected: boolean
  onSelect: () => void
}

export function SessionRow({
  session,
  projectColor,
  isSelected,
  onSelect
}: SessionRowProps): React.JSX.Element {
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault()
        onSelect()
      }
    },
    [onSelect]
  )

  return (
    <div
      role="button"
      tabIndex={0}
      aria-expanded={isSelected}
      aria-label={`Session ${formatTimeRange(session.startedAt, session.endedAt)}, ${formatDuration(session.durationMinutes)}`}
      onClick={onSelect}
      onKeyDown={handleKeyDown}
      className={cn(
        'flex h-10 cursor-pointer items-center gap-3 pl-10 pr-4 transition-colors',
        'hover:bg-[var(--background-elevated)]',
        'focus-visible:outline-2 focus-visible:outline-[var(--accent)]',
        isSelected && 'bg-[var(--background-elevated)]'
      )}
      style={{ borderLeft: `2px solid ${projectColor}` }}
    >
      <span className="shrink-0 font-mono text-[13px] text-[var(--text-secondary)]">
        {formatTimeRange(session.startedAt, session.endedAt)}
      </span>
      <Badge
        variant="secondary"
        className={cn(
          'shrink-0 text-[10px] font-semibold uppercase',
          session.source === 'auto'
            ? 'bg-[rgba(var(--accent-rgb),0.1)] text-[var(--accent)]'
            : 'bg-[rgba(167,139,250,0.1)] text-[#a78bfa]'
        )}
      >
        {session.source === 'auto' ? 'Auto' : 'Manual'}
      </Badge>
      <span className="min-w-0 flex-1" />
      <span className="shrink-0 font-mono text-[13px] font-semibold text-[var(--text-primary)]">
        {formatDuration(session.durationMinutes)}
      </span>
    </div>
  )
}
