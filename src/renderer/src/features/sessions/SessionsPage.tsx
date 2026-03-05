import { useState, useCallback } from 'react'
import { useNavigate } from 'react-router'
import { AlertTriangle, LayoutList, ArrowRight } from 'lucide-react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { EmptyState } from '@/components/shared/EmptyState'
import { StatsBar } from './StatsBar'
import { ProjectGroup } from './ProjectGroup'
import { SessionRow } from './SessionRow'
import { useSessions, useSessionStats, useGroupedSessions } from './use-sessions'
import { useClients } from '../clients/use-clients'
import { useProjects } from '../clients/use-projects'
import { useUIStore } from '@/stores/use-ui-store'
import { getProjectColor, getDateKey, formatDateLabel, formatDuration } from '@/lib/format'
import type { Session } from '../../../../shared/types/session'

function SessionListSkeleton(): React.JSX.Element {
  return (
    <div className="space-y-1 px-4">
      {[1, 2, 3].map((i) => (
        <Skeleton key={i} className="h-12 w-full bg-[var(--background-elevated)]" />
      ))}
    </div>
  )
}

export function SessionsPage(): React.JSX.Element {
  const { data: sessions, isLoading, error } = useSessions()
  const { data: clients } = useClients()
  const { data: allProjects } = useProjects()
  const stats = useSessionStats(sessions, clients, allProjects)
  const groups = useGroupedSessions(sessions, allProjects, clients)
  const queryClient = useQueryClient()
  const setActiveView = useUIStore((s) => s.setActiveView)
  const navigate = useNavigate()

  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set())
  const [selectedSessionId, setSelectedSessionId] = useState<number | null>(null)

  // Opens the Welcome Wizard by clearing setup_complete
  const showWizard = useMutation({
    mutationFn: async () => {
      await window.api.settings.set('setup_complete', '')
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['settings'] })
    }
  })

  const toggleGroup = useCallback((key: string) => {
    setExpandedGroups((prev) => {
      const next = new Set(prev)
      if (next.has(key)) {
        next.delete(key)
      } else {
        next.add(key)
      }
      return next
    })
  }, [])

  // Clear selection when its parent group collapses
  const handleToggleGroup = useCallback(
    (key: string) => {
      if (expandedGroups.has(key)) {
        setSelectedSessionId(null)
      }
      toggleGroup(key)
    },
    [expandedGroups, toggleGroup]
  )

  const selectSession = useCallback((id: number) => {
    setSelectedSessionId((prev) => (prev === id ? null : id))
  }, [])

  const isEmpty = !isLoading && !error && (!sessions || sessions.length === 0)

  return (
    <div className="flex h-full flex-col">
      <StatsBar
        todayTotal={stats.todayTotal}
        activeSessions={stats.activeSessions}
        totalSessions={stats.totalSessions}
        tokensUsed={stats.tokensUsed}
        clientCount={stats.clientCount}
        unassignedCount={stats.unassignedCount}
        isLoading={isLoading}
      />

      <div className="flex-1 overflow-auto">
        {isLoading && <SessionListSkeleton />}

        {error && (
          <EmptyState
            icon={AlertTriangle}
            title="Failed to Load Sessions"
            description={error.message}
          />
        )}

        {isEmpty && (
          <EmptyState
            icon={LayoutList}
            title="No Sessions Found"
            description="Scan for your Claude Code projects and import session history"
            action={
              <Button
                onClick={() => showWizard.mutate()}
                className="bg-[var(--accent)] text-white hover:brightness-[1.15]"
              >
                Scan for Projects
              </Button>
            }
          />
        )}

        {!isLoading && !isEmpty && (
          <div className="divide-y divide-[var(--surface-border)]">
            {groups.map((group) => {
              const groupKey = group.projectId != null
                ? `project:${group.projectId}`
                : `path:${group.projectPath}`
              const color = group.clientColor ?? getProjectColor(group.projectPath)

              return (
                <ProjectGroup
                  key={groupKey}
                  projectName={group.projectName}
                  projectColor={color}
                  clientName={group.clientName}
                  isUnassigned={group.isUnassigned}
                  sessionCount={group.sessionCount}
                  totalDurationMinutes={group.totalDurationMinutes}
                  isExpanded={expandedGroups.has(groupKey)}
                  onToggle={() => handleToggleGroup(groupKey)}
                >
                  <div className="pb-1">
                    {group.isUnassigned && (
                      <button
                        type="button"
                        onClick={() => { setActiveView('/clients'); navigate('/clients') }}
                        className="flex w-full items-center gap-2 px-10 py-2 text-[12px] text-[var(--text-muted)] transition-colors hover:text-[var(--accent)]"
                      >
                        <ArrowRight size={12} />
                        Map this directory to a client in Clients view
                      </button>
                    )}
                    {groupSessionsByDay(group.sessions).map((dayGroup) => (
                      <div key={dayGroup.dateKey}>
                        <div className="flex items-center justify-between px-10 py-1.5">
                          <span className="text-[11px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
                            {dayGroup.label}
                          </span>
                          <span className="text-[11px] text-[var(--text-muted)]">
                            {dayGroup.sessions.length} session{dayGroup.sessions.length !== 1 ? 's' : ''} · {formatDuration(dayGroup.totalMinutes)}
                          </span>
                        </div>
                        {dayGroup.sessions.map((session) => (
                          <SessionRow
                            key={session.id}
                            session={session}
                            projectColor={color}
                            isSelected={selectedSessionId === session.id}
                            onSelect={() => selectSession(session.id)}
                          />
                        ))}
                      </div>
                    ))}
                  </div>
                </ProjectGroup>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}

interface DayGroup {
  dateKey: string
  label: string
  sessions: Session[]
  totalMinutes: number
}

function groupSessionsByDay(sessions: Session[]): DayGroup[] {
  const groups = new Map<string, Session[]>()
  for (const session of sessions) {
    const key = getDateKey(session.startedAt)
    const existing = groups.get(key) ?? []
    existing.push(session)
    groups.set(key, existing)
  }

  return Array.from(groups.entries())
    .sort(([a], [b]) => b.localeCompare(a)) // newest day first
    .map(([dateKey, daySessions]) => ({
      dateKey,
      label: formatDateLabel(daySessions[0].startedAt),
      sessions: daySessions,
      totalMinutes: daySessions.reduce((sum, s) => sum + s.durationMinutes, 0)
    }))
}
