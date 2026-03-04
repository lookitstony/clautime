import { useState, useCallback } from 'react'
import { AlertTriangle, LayoutList } from 'lucide-react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { EmptyState } from '@/components/shared/EmptyState'
import { StatsBar } from './StatsBar'
import { ProjectGroup } from './ProjectGroup'
import { SessionRow } from './SessionRow'
import { useSessions, useSessionStats, useGroupedSessions } from './use-sessions'
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
  const stats = useSessionStats(sessions)
  const groups = useGroupedSessions(sessions)
  const queryClient = useQueryClient()

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

  const toggleGroup = useCallback((projectPath: string) => {
    setExpandedGroups((prev) => {
      const isCollapsing = prev.has(projectPath)
      const next = new Set(prev)
      if (isCollapsing) {
        next.delete(projectPath)
      } else {
        next.add(projectPath)
      }
      return next
    })
  }, [])

  // Clear selection when its parent group collapses
  const handleToggleGroup = useCallback(
    (projectPath: string) => {
      if (expandedGroups.has(projectPath)) {
        setSelectedSessionId(null)
      }
      toggleGroup(projectPath)
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
            {groups.map((group) => (
              <ProjectGroup
                key={group.projectPath}
                projectName={group.projectName}
                projectColor={getProjectColor(group.projectPath)}
                sessionCount={group.sessionCount}
                totalDurationMinutes={group.totalDurationMinutes}
                isExpanded={expandedGroups.has(group.projectPath)}
                onToggle={() => handleToggleGroup(group.projectPath)}
              >
                <div className="pb-1">
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
                          projectColor={getProjectColor(group.projectPath)}
                          isSelected={selectedSessionId === session.id}
                          onSelect={() => selectSession(session.id)}
                        />
                      ))}
                    </div>
                  ))}
                </div>
              </ProjectGroup>
            ))}
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
