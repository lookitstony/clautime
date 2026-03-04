import { type ReactNode, useCallback, type KeyboardEvent } from 'react'
import { ChevronRight } from 'lucide-react'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger
} from '@/components/ui/collapsible'
import { Badge } from '@/components/ui/badge'
import { formatDuration } from '@/lib/format'
import { cn } from '@/lib/utils'

interface ProjectGroupProps {
  projectName: string
  projectColor: string
  sessionCount: number
  totalDurationMinutes: number
  isExpanded: boolean
  onToggle: () => void
  children: ReactNode
}

export function ProjectGroup({
  projectName,
  projectColor,
  sessionCount,
  totalDurationMinutes,
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

  return (
    <Collapsible open={isExpanded} onOpenChange={onToggle}>
      <CollapsibleTrigger asChild>
        <div
          role="group"
          aria-expanded={isExpanded}
          aria-label={`${projectName} - ${sessionCount} sessions, ${formatDuration(totalDurationMinutes)} total`}
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
            className="h-2 w-2 shrink-0 rounded-full"
            style={{ backgroundColor: projectColor }}
          />
          <span className="min-w-0 flex-1 truncate text-[13px] font-semibold">
            {projectName}
          </span>
          <Badge
            variant="secondary"
            className="shrink-0 bg-[var(--background-elevated)] text-[10px] font-semibold uppercase text-[var(--text-secondary)]"
          >
            {sessionCount}
          </Badge>
          <span className="shrink-0 font-mono text-[13px] font-bold text-[var(--accent)]">
            {formatDuration(totalDurationMinutes)}
          </span>
        </div>
      </CollapsibleTrigger>
      <CollapsibleContent>{children}</CollapsibleContent>
    </Collapsible>
  )
}
