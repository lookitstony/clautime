import { type ReactNode, useCallback, type KeyboardEvent } from 'react'
import { ChevronRight } from 'lucide-react'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger
} from '@/components/ui/collapsible'
import { Badge } from '@/components/ui/badge'
import { formatDuration, formatCompactNumber } from '@/lib/format'
import { cn } from '@/lib/utils'

interface ProjectGroupProps {
  projectName: string
  projectColor: string
  clientName?: string | null
  isUnassigned?: boolean
  sessionCount: number
  totalDurationMinutes: number
  totalPrompts: number
  totalTokens: number
  isExpanded: boolean
  onToggle: () => void
  children: ReactNode
}

export function ProjectGroup({
  projectName,
  projectColor,
  clientName,
  isUnassigned,
  sessionCount,
  totalDurationMinutes,
  totalPrompts,
  totalTokens,
  isExpanded,
  onToggle,
  children
}: ProjectGroupProps): React.JSX.Element {
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault()
        onToggle()
      }
    },
    [onToggle]
  )

  const label = isUnassigned
    ? `${projectName} (Unassigned)`
    : clientName
      ? `${clientName} / ${projectName}`
      : projectName

  return (
    <Collapsible open={isExpanded} onOpenChange={onToggle}>
      <CollapsibleTrigger asChild>
        <div
          role="group"
          aria-expanded={isExpanded}
          aria-label={`${label} - ${sessionCount} sessions, ${formatDuration(totalDurationMinutes)} total`}
          tabIndex={0}
          onKeyDown={handleKeyDown}
          className={cn(
            'flex h-12 cursor-pointer items-center gap-3 px-4 transition-colors',
            'hover:bg-[var(--background-elevated)]',
            'focus-visible:outline-2 focus-visible:outline-[var(--accent)]'
          )}
        >
          <ChevronRight
            size={16}
            className={cn(
              'shrink-0 text-[var(--text-muted)] transition-transform duration-200',
              isExpanded && 'rotate-90'
            )}
          />
          <span
            className={cn('h-2 w-2 shrink-0 rounded-full', isUnassigned && 'opacity-40')}
            style={{ backgroundColor: isUnassigned ? 'var(--text-muted)' : projectColor }}
          />
          <span className="min-w-0 flex-1 truncate text-[13px] font-semibold">
            {clientName && !isUnassigned && (
              <span className="font-normal text-[var(--text-muted)]">
                {clientName}
                <span className="mx-1.5">/</span>
              </span>
            )}
            {projectName}
          </span>
          <span className="w-[5.5rem] shrink-0 text-right text-[11px] text-[var(--text-muted)]">
            {sessionCount} {sessionCount === 1 ? 'session' : 'sessions'}
          </span>
          <span className="w-[5.5rem] shrink-0 text-right text-[11px] text-[var(--text-muted)]">
            {totalPrompts} {totalPrompts === 1 ? 'prompt' : 'prompts'}
          </span>
          {totalTokens > 0 && (
            <span className="w-[4.5rem] shrink-0 text-right font-mono text-[11px] text-[var(--text-muted)]">
              {formatCompactNumber(totalTokens)}
            </span>
          )}
          <span className="w-[4.5rem] shrink-0 text-right font-mono text-[13px] font-bold text-[var(--accent)]">
            {formatDuration(totalDurationMinutes)}
          </span>
        </div>
      </CollapsibleTrigger>
      <CollapsibleContent>{children}</CollapsibleContent>
    </Collapsible>
  )
}
