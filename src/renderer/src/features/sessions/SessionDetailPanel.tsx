import { useState, useEffect, useRef, useCallback, type KeyboardEvent } from 'react'
import { ChevronRight } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { formatDuration, formatTimeRange } from '@/lib/format'
import { cn } from '@/lib/utils'
import { usePromptTimings } from './use-sessions'
import type { Session, PromptTiming } from '../../../../shared/types/session'

interface SessionDetailPanelProps {
  session: Session
  projectName: string | null
  clientName: string | null
  projectColor: string
  onClose: () => void
}

function StatCard({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <div className="rounded-md bg-[var(--background-secondary)] px-3 py-2">
      <div className="font-mono text-[13px] font-semibold text-[var(--text-primary)]">{value}</div>
      <div className="text-[11px] text-[var(--text-muted)]">{label}</div>
    </div>
  )
}

function formatTime(isoString: string): string {
  return new Date(isoString).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })
}

function formatLatency(seconds: number | null): string {
  if (seconds == null) return '—'
  if (seconds < 60) return `${seconds}s`
  const min = Math.floor(seconds / 60)
  const sec = seconds % 60
  return sec > 0 ? `${min}m ${sec}s` : `${min}m`
}

function PromptTimeline({ timings }: { timings: PromptTiming[] }): React.JSX.Element {
  return (
    <div className="space-y-0">
      {timings.map((t, i) => (
        <div
          key={i}
          className="flex items-center gap-3 px-1 py-1 text-[12px]"
        >
          <span className="w-5 shrink-0 text-right font-mono text-[var(--text-muted)]">
            {i + 1}
          </span>
          <span className="shrink-0 font-mono text-[var(--text-secondary)]">
            {formatTime(t.promptAt)}
          </span>
          <span className="text-[var(--text-muted)]">{'\u2192'}</span>
          <span className="shrink-0 font-mono text-[var(--text-secondary)]">
            {t.responseAt ? formatTime(t.responseAt) : '—'}
          </span>
          <span className={cn(
            'shrink-0 font-mono font-semibold',
            t.latencySeconds != null && t.latencySeconds > 60
              ? 'text-[#f59e0b]'
              : 'text-[var(--accent)]'
          )}>
            {formatLatency(t.latencySeconds)}
          </span>
        </div>
      ))}
    </div>
  )
}

export function SessionDetailPanel({
  session,
  projectName,
  clientName,
  projectColor,
  onClose
}: SessionDetailPanelProps): React.JSX.Element {
  const panelRef = useRef<HTMLDivElement>(null)
  const [showTimings, setShowTimings] = useState(false)
  const { data: timings, isLoading: timingsLoading, isError, error } = usePromptTimings(
    showTimings ? session.id : null
  )

  useEffect(() => {
    panelRef.current?.focus()
    panelRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
  }, [])

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      }
    },
    [onClose]
  )

  const isAuto = session.source === 'auto'

  return (
    <div
      ref={panelRef}
      tabIndex={-1}
      role="region"
      aria-label={`Details for session ${formatTimeRange(session.startedAt, session.endedAt)}`}
      onKeyDown={handleKeyDown}
      className="border-t border-[var(--surface-border)] bg-[var(--background-elevated)] px-10 py-4 outline-none"
      style={{ borderLeft: `2px solid ${projectColor}` }}
    >
      {/* Stat cards grid */}
      <div className="mb-4 grid grid-cols-4 gap-3">
        <StatCard label="Duration" value={formatDuration(session.durationMinutes)} />
        <StatCard label="Time Range" value={formatTimeRange(session.startedAt, session.endedAt)} />
        <StatCard label="Prompts" value={String(session.promptCount)} />
        <StatCard
          label="Source"
          value={isAuto ? 'Auto-detected' : 'Manual'}
        />
      </div>

      {/* Project / Client attribution */}
      {(projectName || clientName) && (
        <div className="mb-3 flex items-center gap-2 text-[13px]">
          <span
            className="h-2 w-2 shrink-0 rounded-full"
            style={{ backgroundColor: projectColor }}
          />
          {clientName && (
            <span className="text-[var(--text-muted)]">
              {clientName}
              <span className="mx-1.5">/</span>
            </span>
          )}
          {projectName && (
            <span className="font-semibold text-[var(--text-primary)]">{projectName}</span>
          )}
        </div>
      )}

      {/* Description / Summary */}
      <div className="mb-4">
        <div className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
          Description
        </div>
        {session.description ? (
          <p className="text-[13px] leading-relaxed text-[var(--text-secondary)]">
            {session.description}
          </p>
        ) : (
          <p className="text-[13px] italic text-[var(--text-muted)]">No summary available</p>
        )}
      </div>

      {/* Prompt Timeline (collapsible) */}
      {isAuto && session.promptCount > 0 && (
        <div className="mb-4">
          <button
            type="button"
            onClick={() => setShowTimings((v) => !v)}
            className="mb-2 flex items-center gap-1 text-[11px] font-semibold uppercase tracking-wider text-[var(--text-muted)] transition-colors hover:text-[var(--text-secondary)]"
          >
            <ChevronRight
              size={12}
              className={cn('transition-transform duration-200', showTimings && 'rotate-90')}
            />
            Prompt Timeline
          </button>
          {showTimings && (
            <div className="rounded-md bg-[var(--background-secondary)] px-3 py-2">
              {timingsLoading && (
                <p className="text-[12px] text-[var(--text-muted)]">Loading timings...</p>
              )}
              {isError && (
                <p className="text-[12px] italic text-[var(--text-muted)]">
                  Failed to load timings{error instanceof Error ? `: ${error.message}` : ''}
                </p>
              )}
              {timings && timings.length > 0 && <PromptTimeline timings={timings} />}
              {timings && timings.length === 0 && (
                <p className="text-[12px] italic text-[var(--text-muted)]">No prompt data found in source file</p>
              )}
            </div>
          )}
        </div>
      )}

      {/* Action buttons */}
      <div className="flex items-center gap-2">
        {isAuto ? (
          <>
            <Button variant="ghost" size="sm" disabled title="Coming in a future update">
              Edit Time
            </Button>
            <Button variant="ghost" size="sm" disabled title="Coming in a future update">
              Reassign Project
            </Button>
          </>
        ) : (
          <>
            <Button variant="ghost" size="sm" disabled title="Coming in a future update">
              Edit Description
            </Button>
            <Button variant="ghost" size="sm" disabled title="Coming in a future update">
              Delete
            </Button>
          </>
        )}
      </div>
    </div>
  )
}
