import { useCallback, type KeyboardEvent, type MouseEvent } from 'react'
import { GitCommitHorizontal } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { formatTimeRange, formatDuration } from '@/lib/format'
import { cn } from '@/lib/utils'
import type { Session } from '../../../../shared/types/session'

interface SessionRowProps {
  session: Session
  projectColor: string
  isSelected: boolean
  hasCommits?: boolean
  onSelect: (e?: MouseEvent<HTMLDivElement> | KeyboardEvent<HTMLDivElement>) => void
}

export function SessionRow({
  session,
  projectColor,
  isSelected,
  hasCommits,
  onSelect
}: SessionRowProps): React.JSX.Element {
  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLDivElement>) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault()
        onSelect(e)
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
      {hasCommits && (
        <GitCommitHorizontal
          size={14}
          className="shrink-0 text-[var(--accent)]"
          aria-label="Has git commits"
        />
      )}
      <span className="min-w-0 flex-1" />
      <span className="w-[5.5rem] shrink-0" />
      <span className="w-[5.5rem] shrink-0 text-right text-[11px] text-[var(--text-muted)]">
        {session.promptCount > 0
          ? `${session.promptCount} ${session.promptCount === 1 ? 'prompt' : 'prompts'}`
          : ''}
      </span>
      <span className="w-[4.5rem] shrink-0 text-right font-mono text-[13px] font-semibold text-[var(--text-primary)]">
        {formatDuration(session.durationMinutes)}
      </span>
    </div>
  )
}
