import {
  useState,
  useEffect,
  useRef,
  useCallback,
  type KeyboardEvent,
  type ChangeEvent
} from 'react'
import { ChevronRight, Pencil, Trash2, GitCommitHorizontal, DollarSign } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { formatDuration, formatTimeRange, formatCompactNumber } from '@/lib/format'
import { cn } from '@/lib/utils'
import { usePromptTimings, useUpdateSession, useDeleteSession } from './use-sessions'
import { useGitCommitsForSession, useGitRemoteUrl } from '../git/use-git'
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
  return new Date(isoString).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  })
}

/** Convert HH:MM or HH:MM:SS to an ISO string on the same date as the reference. */
function timeStringToIso(timeStr: string, referenceIso: string): string | null {
  const parts = timeStr.split(':').map(Number)
  if (parts.length < 2 || parts.some(isNaN)) return null
  const [h, m, s = 0] = parts
  if (h < 0 || h > 23 || m < 0 || m > 59 || s < 0 || s > 59) return null
  const ref = new Date(referenceIso)
  const d = new Date(ref.getFullYear(), ref.getMonth(), ref.getDate(), h, m, s)
  return d.toISOString()
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
        <div key={i} className="flex items-center gap-3 px-1 py-1 text-[12px]">
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
          <span
            className={cn(
              'shrink-0 font-mono font-semibold',
              t.latencySeconds != null && t.latencySeconds > 60
                ? 'text-[#f59e0b]'
                : 'text-[var(--accent)]'
            )}
          >
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
  const {
    data: timings,
    isLoading: timingsLoading,
    isError,
    error
  } = usePromptTimings(showTimings ? session.id : null)

  // Git commits - always load for description fallback
  const [showCommits, setShowCommits] = useState(false)
  const { data: gitCommitsData } = useGitCommitsForSession(session.id)
  const { data: remoteUrl } = useGitRemoteUrl(showCommits ? session.projectId : null)

  // Edit time state
  const [isEditingTime, setIsEditingTime] = useState(false)
  const [editStart, setEditStart] = useState('')
  const [editEnd, setEditEnd] = useState('')
  const [editError, setEditError] = useState<string | null>(null)

  // Edit description state (manual sessions)
  const [isEditingDesc, setIsEditingDesc] = useState(false)
  const [editDesc, setEditDesc] = useState('')

  // Delete confirmation state (manual sessions)
  const [isConfirmingDelete, setIsConfirmingDelete] = useState(false)

  const updateSession = useUpdateSession()
  const deleteSession = useDeleteSession()

  useEffect(() => {
    panelRef.current?.focus()
    panelRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
  }, [])

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (isEditingTime) {
          setIsEditingTime(false)
          setEditError(null)
          e.stopPropagation()
          return
        }
        e.stopPropagation()
        onClose()
      }
    },
    [onClose, isEditingTime]
  )

  // Edit time handlers

  const computeEditDuration = (): number | null => {
    const startIso = timeStringToIso(editStart, session.startedAt)
    const endIso = timeStringToIso(editEnd, session.endedAt)
    if (!startIso || !endIso) return null
    const diffMs = new Date(endIso).getTime() - new Date(startIso).getTime()
    if (diffMs <= 0) return null
    return Math.round(diffMs / 60_000)
  }

  const saveTimeEdit = useCallback(() => {
    const startIso = timeStringToIso(editStart, session.startedAt)
    const endIso = timeStringToIso(editEnd, session.endedAt)
    if (!startIso || !endIso) {
      setEditError('Invalid time format (HH:MM:SS)')
      return
    }
    if (new Date(endIso).getTime() <= new Date(startIso).getTime()) {
      setEditError('End time must be after start time')
      return
    }

    const durationMinutes = Math.round(
      (new Date(endIso).getTime() - new Date(startIso).getTime()) / 60_000
    )

    // Save previous values for undo
    const prev = {
      startedAt: session.startedAt,
      endedAt: session.endedAt,
      durationMinutes: session.durationMinutes
    }

    updateSession.mutate(
      { id: session.id, data: { startedAt: startIso, endedAt: endIso, durationMinutes } },
      {
        onSuccess: () => {
          setIsEditingTime(false)
          setEditError(null)
          toast.success('Session updated', {
            action: {
              label: 'Undo',
              onClick: () => {
                updateSession.mutate({ id: session.id, data: prev })
              }
            },
            duration: 5000
          })
        },
        onError: (err) => {
          setEditError(err.message)
        }
      }
    )
  }, [editStart, editEnd, session, updateSession])

  const handleTimeKeyDown = useCallback(
    (e: KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Enter') {
        e.preventDefault()
        saveTimeEdit()
      } else if (e.key === 'Escape') {
        e.stopPropagation()
        setIsEditingTime(false)
        setEditError(null)
      }
    },
    [saveTimeEdit]
  )

  // Edit description handlers
  const startEditDesc = useCallback(() => {
    setEditDesc(session.description ?? '')
    setIsEditingDesc(true)
  }, [session.description])

  const saveDescEdit = useCallback(() => {
    const prev = { description: session.description }
    updateSession.mutate(
      { id: session.id, data: { description: editDesc || null } },
      {
        onSuccess: () => {
          setIsEditingDesc(false)
          toast.success('Description updated', {
            action: {
              label: 'Undo',
              onClick: () => {
                updateSession.mutate({ id: session.id, data: prev })
              }
            },
            duration: 5000
          })
        }
      }
    )
  }, [editDesc, session, updateSession])

  const handleDescKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        saveDescEdit()
      } else if (e.key === 'Escape') {
        e.stopPropagation()
        setIsEditingDesc(false)
      }
    },
    [saveDescEdit]
  )

  // Delete handler
  const handleDelete = useCallback(() => {
    deleteSession.mutate(session.id, {
      onSuccess: () => {
        toast.success('Session deleted')
        onClose()
      }
    })
  }, [session.id, deleteSession, onClose])

  const isAuto = session.source === 'auto'
  const editDuration = isEditingTime ? computeEditDuration() : null

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
        {isEditingTime ? (
          <div className="col-span-2 rounded-md bg-[var(--background-secondary)] px-3 py-2">
            <div className="flex items-center gap-2">
              <input
                type="text"
                value={editStart}
                onChange={(e: ChangeEvent<HTMLInputElement>) => {
                  setEditStart(e.target.value)
                  setEditError(null)
                }}
                onKeyDown={handleTimeKeyDown}
                placeholder="HH:MM:SS"
                className="w-24 rounded border border-[var(--surface-border)] bg-[var(--background-primary)] px-2 py-1 font-mono text-[13px] text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
                autoFocus
              />
              <span className="text-[var(--text-muted)]">{'\u2013'}</span>
              <input
                type="text"
                value={editEnd}
                onChange={(e: ChangeEvent<HTMLInputElement>) => {
                  setEditEnd(e.target.value)
                  setEditError(null)
                }}
                onKeyDown={handleTimeKeyDown}
                placeholder="HH:MM:SS"
                className="w-24 rounded border border-[var(--surface-border)] bg-[var(--background-primary)] px-2 py-1 font-mono text-[13px] text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
              />
            </div>
            <div className="mt-1 flex items-center gap-2">
              {editError && (
                <span className="text-[11px] text-[var(--destructive)]">{editError}</span>
              )}
              {!editError && editDuration != null && (
                <span className="text-[11px] text-[var(--text-muted)]">
                  Duration: {formatDuration(editDuration)}
                </span>
              )}
            </div>
            <div className="mt-2 flex gap-1">
              <Button size="xs" onClick={saveTimeEdit}>
                Save
              </Button>
              <Button
                size="xs"
                variant="ghost"
                onClick={() => {
                  setIsEditingTime(false)
                  setEditError(null)
                }}
              >
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <>
            <StatCard label="Duration" value={formatDuration(session.durationMinutes)} />
            <StatCard
              label="Time Range"
              value={formatTimeRange(session.startedAt, session.endedAt)}
            />
          </>
        )}
        {isAuto && <StatCard label="Prompts" value={String(session.promptCount)} />}
        {isAuto && (session.inputTokens > 0 || session.outputTokens > 0) && (
          <StatCard
            label="Tokens"
            value={formatCompactNumber(session.inputTokens + session.outputTokens)}
          />
        )}
        <StatCard label="Source" value={isAuto ? 'Auto-detected' : 'Manual'} />
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

      {/* Description / Git commit summaries */}
      <div className="mb-4">
        <span className="mb-1 block text-[11px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
          Description
        </span>
        {isEditingDesc ? (
          <div>
            <textarea
              value={editDesc}
              onChange={(e) => setEditDesc(e.target.value)}
              onKeyDown={handleDescKeyDown}
              rows={3}
              className="w-full rounded border border-[var(--surface-border)] bg-[var(--background-primary)] px-3 py-2 text-[13px] text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
              autoFocus
            />
            <div className="mt-1 flex gap-1">
              <Button size="xs" onClick={saveDescEdit}>
                Save
              </Button>
              <Button size="xs" variant="ghost" onClick={() => setIsEditingDesc(false)}>
                Cancel
              </Button>
            </div>
          </div>
        ) : session.description ? (
          <p className="text-[13px] leading-relaxed text-[var(--text-secondary)]">
            {session.description}
          </p>
        ) : gitCommitsData && gitCommitsData.length > 0 ? (
          <div className="space-y-0.5 text-[13px] leading-relaxed text-[var(--text-secondary)]">
            {gitCommitsData.map((c) => (
              <div key={c.id} className="flex items-start gap-1.5">
                <span className="shrink-0 text-[var(--text-muted)]">{'\u2022'}</span>
                <span>{c.message}</span>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-[13px] italic text-[var(--text-muted)]">No description</p>
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
                <p className="text-[12px] italic text-[var(--text-muted)]">
                  No prompt data found in source file
                </p>
              )}
            </div>
          )}
        </div>
      )}

      {/* Git Commits (collapsible) */}
      {isAuto && session.projectId && (
        <div className="mb-4">
          <button
            type="button"
            onClick={() => setShowCommits((v) => !v)}
            className="mb-2 flex items-center gap-1 text-[11px] font-semibold uppercase tracking-wider text-[var(--text-muted)] transition-colors hover:text-[var(--text-secondary)]"
          >
            <ChevronRight
              size={12}
              className={cn('transition-transform duration-200', showCommits && 'rotate-90')}
            />
            Git Commits
          </button>
          {showCommits && (
            <div className="rounded-md bg-[var(--background-secondary)] px-3 py-2">
              {gitCommitsData && gitCommitsData.length > 0 ? (
                <div className="space-y-1">
                  {gitCommitsData.map((c) => (
                    <div key={c.id} className="flex items-start gap-2 text-[12px]">
                      <GitCommitHorizontal
                        size={12}
                        className="mt-0.5 shrink-0 text-[var(--text-muted)]"
                      />
                      {remoteUrl ? (
                        <a
                          href={`${remoteUrl}/commit/${c.hash}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="font-mono text-[11px] text-[var(--accent)] hover:underline"
                        >
                          {c.hash.slice(0, 7)}
                        </a>
                      ) : (
                        <span className="font-mono text-[11px] text-[var(--text-muted)]">
                          {c.hash.slice(0, 7)}
                        </span>
                      )}
                      <span className="text-[var(--text-secondary)]">{c.message}</span>
                    </div>
                  ))}
                </div>
              ) : gitCommitsData && gitCommitsData.length === 0 ? (
                <p className="text-[12px] italic text-[var(--text-muted)]">
                  No commits found for this session
                </p>
              ) : (
                <p className="text-[12px] text-[var(--text-muted)]">Loading...</p>
              )}
            </div>
          )}
        </div>
      )}

      {/* Action buttons */}
      <div className="flex items-center gap-2">
        {isAuto ? null : (
          <>
            <Button variant="ghost" size="sm" onClick={startEditDesc} disabled={isEditingDesc}>
              <Pencil className="mr-1 h-3 w-3" />
              Edit Description
            </Button>
            {isConfirmingDelete ? (
              <div className="flex items-center gap-1">
                <span className="text-[12px] text-[var(--text-muted)]">Delete this session?</span>
                <Button variant="destructive" size="xs" onClick={handleDelete}>
                  Confirm
                </Button>
                <Button variant="ghost" size="xs" onClick={() => setIsConfirmingDelete(false)}>
                  Cancel
                </Button>
              </div>
            ) : (
              <Button variant="ghost" size="sm" onClick={() => setIsConfirmingDelete(true)}>
                <Trash2 className="mr-1 h-3 w-3" />
                Delete
              </Button>
            )}
          </>
        )}
        <div className="flex-1" />
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            updateSession.mutate(
              { id: session.id, data: { billable: !session.billable } },
              {
                onSuccess: () =>
                  toast.success(session.billable ? 'Marked as non-billable' : 'Marked as billable')
              }
            )
          }}
          className={cn(
            'text-[11px]',
            session.billable ? 'text-[var(--text-muted)]' : 'text-amber-400'
          )}
        >
          <DollarSign className="mr-1 h-3 w-3" />
          {session.billable ? 'Billable' : 'Non-billable'}
        </Button>
      </div>
    </div>
  )
}
