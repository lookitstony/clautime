import React, { useState, useCallback, useRef, useMemo, useEffect } from 'react'
import { useNavigate } from 'react-router'
import { AlertTriangle, LayoutList, ArrowRight, ChevronDown, ChevronUp, ChevronRight, Plus } from 'lucide-react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { EmptyState } from '@/components/shared/EmptyState'
import { StatsBar } from './StatsBar'
import { ProjectGroup } from './ProjectGroup'
import { SessionRow } from './SessionRow'
import { SessionDetailPanel } from './SessionDetailPanel'
import { SessionFilterBar } from './SessionFilterBar'
import { ManualBlockForm } from './ManualBlockForm'
import { useSessions, useSessionStats, useGroupedSessions } from './use-sessions'
import { useClients } from '../clients/use-clients'
import { useProjects } from '../clients/use-projects'
import { useSessionIdsWithCommits } from '../git/use-git'
import { useUIStore } from '@/stores/use-ui-store'
import { useFilterStore } from '@/stores/use-filter-store'
import { cn } from '@/lib/utils'
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
  const datePreset = useFilterStore((s) => s.datePreset)
  const startDate = useFilterStore((s) => s.startDate)
  const endDate = useFilterStore((s) => s.endDate)
  const filterClientId = useFilterStore((s) => s.clientId)
  const filterProjectId = useFilterStore((s) => s.projectId)
  const storeWeekStartDay = useFilterStore((s) => s.weekStartDay)
  const filters = useMemo(
    () => useFilterStore.getState().toSessionFilters(),
    [datePreset, startDate, endDate, filterClientId, filterProjectId, storeWeekStartDay]
  )
  const { data: rawSessions, isLoading, error } = useSessions(filters)
  const { data: clients } = useClients()
  const { data: allProjects } = useProjects()

  const { data: settingsData } = useQuery({
    queryKey: ['settings', 'all'],
    queryFn: async () => {
      const r = await window.api.settings.getAll()
      return r.success ? r.data : {}
    }
  })
  const afterHoursMode = settingsData?.['after_hours_mode'] === 'true'
  const weekStartDay = parseInt(settingsData?.['week_start_day'] ?? '1', 10)
  useEffect(() => {
    useFilterStore.getState().setWeekStartDay(weekStartDay)
  }, [weekStartDay])

  const sessions = useMemo(() => {
    if (!rawSessions || !afterHoursMode) return rawSessions
    return rawSessions.filter((s) => {
      const hour = new Date(s.startedAt).getHours()
      return hour < 7 || hour >= 18
    })
  }, [rawSessions, afterHoursMode])

  const { data: sessionIdsWithCommits } = useSessionIdsWithCommits()
  const stats = useSessionStats(sessions, clients, sessionIdsWithCommits)
  const groups = useGroupedSessions(sessions, allProjects, clients)
  const queryClient = useQueryClient()
  const setActiveView = useUIStore((s) => s.setActiveView)
  const navigate = useNavigate()

  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set())
  const [expandedDays, setExpandedDays] = useState<Set<string>>(new Set())
  const [selectedSessionId, setSelectedSessionId] = useState<number | null>(null)
  const [showManualForm, setShowManualForm] = useState(false)

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

  const toggleDay = useCallback((dayKey: string) => {
    setExpandedDays((prev) => {
      const next = new Set(prev)
      if (next.has(dayKey)) {
        next.delete(dayKey)
      } else {
        next.add(dayKey)
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

  const allGroupKeys = useMemo(
    () => groups.map((g) => g.projectId != null ? `project:${g.projectId}` : `path:${g.projectPath}`),
    [groups]
  )

  const allDayKeys = useMemo(() => {
    const keys: string[] = []
    for (const group of groups) {
      const groupKey = group.projectId != null ? `project:${group.projectId}` : `path:${group.projectPath}`
      for (const session of group.sessions) {
        const dk = `${groupKey}:${getDateKey(session.startedAt)}`
        if (!keys.includes(dk)) keys.push(dk)
      }
    }
    return keys
  }, [groups])

  const expandAll = useCallback(() => {
    setExpandedGroups(new Set(allGroupKeys))
    setExpandedDays(new Set(allDayKeys))
  }, [allGroupKeys, allDayKeys])

  const collapseAll = useCallback(() => {
    setExpandedGroups(new Set())
    setExpandedDays(new Set())
    setSelectedSessionId(null)
  }, [])

  const expandAllDays = useCallback(() => {
    setExpandedDays(new Set(allDayKeys))
  }, [allDayKeys])

  const collapseAllDays = useCallback(() => {
    setExpandedDays(new Set())
    setSelectedSessionId(null)
  }, [])

  const sessionRowRef = useRef<HTMLElement | null>(null)

  const selectSession = useCallback((id: number, rowEl?: HTMLElement | null) => {
    if (rowEl) sessionRowRef.current = rowEl
    setSelectedSessionId((prev) => (prev === id ? null : id))
  }, [])

  const handleCloseDetail = useCallback(() => {
    setSelectedSessionId(null)
    // Return focus to the trigger row
    requestAnimationFrame(() => {
      sessionRowRef.current?.focus()
    })
  }, [])

  const hasResults = !isLoading && !error && sessions && sessions.length > 0
  const hasFilters = useFilterStore((s) => s.hasActiveFilters())
  const isEmpty = !isLoading && !error && (!sessions || sessions.length === 0)
  const isFilteredEmpty = isEmpty && hasFilters

  return (
    <div className="flex h-full flex-col">
      <StatsBar
        humanHours={stats.humanHours}
        totalHours={stats.totalHours}
        totalSessions={stats.totalSessions}
        totalPrompts={stats.totalPrompts}
        totalTokens={stats.totalTokens}
        clientCount={stats.clientCount}
        commitSessions={stats.commitSessions}
        isLoading={isLoading}
      />

      {!isLoading && (hasResults || hasFilters) && (
        <SessionFilterBar
          clients={clients ?? []}
          projects={allProjects ?? []}
        />
      )}

      {hasResults && (
        <div className="flex items-center gap-1 border-b border-[var(--surface-border)] px-4 py-1">
          <span className="mr-auto text-[11px] text-[var(--text-muted)]">
            {groups.length} project{groups.length !== 1 ? 's' : ''}
          </span>
          <Button
            size="xs"
            onClick={() => setShowManualForm(true)}
          >
            <Plus className="mr-0.5 h-3 w-3" />
            Manual Block
          </Button>
          <span className="mx-1 h-3 w-px bg-[var(--surface-border)]" />
          <Button variant="ghost" size="xs" onClick={expandAll}>
            <ChevronDown className="mr-0.5 h-3 w-3" />
            Expand All
          </Button>
          <Button variant="ghost" size="xs" onClick={collapseAll}>
            <ChevronUp className="mr-0.5 h-3 w-3" />
            Collapse All
          </Button>
          <span className="mx-1 h-3 w-px bg-[var(--surface-border)]" />
          <Button variant="ghost" size="xs" onClick={expandAllDays}>
            <ChevronDown className="mr-0.5 h-3 w-3" />
            Days
          </Button>
          <Button variant="ghost" size="xs" onClick={collapseAllDays}>
            <ChevronUp className="mr-0.5 h-3 w-3" />
            Days
          </Button>
        </div>
      )}

      <div className="flex-1 overflow-auto">
        {isLoading && <SessionListSkeleton />}

        {error && (
          <EmptyState
            icon={AlertTriangle}
            title="Failed to Load Sessions"
            description={error.message}
          />
        )}

        {isFilteredEmpty && (
          <EmptyState
            icon={LayoutList}
            title="No Matching Sessions"
            description="No sessions match the current filters"
            action={
              <Button
                onClick={() => useFilterStore.getState().clearFilters()}
                variant="ghost"
              >
                Clear Filters
              </Button>
            }
          />
        )}

        {isEmpty && !hasFilters && (
          <EmptyState
            icon={LayoutList}
            title="No Sessions Found"
            description="Scan for your Claude Code projects and import session history"
            action={
              <Button onClick={() => showWizard.mutate()}>
                Scan for Projects
              </Button>
            }
          />
        )}

        {hasResults && (
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
                  totalPrompts={group.totalPrompts}
                  totalTokens={group.totalTokens}
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
                    {groupSessionsByDay(group.sessions).map((dayGroup) => {
                      const dayKey = `${groupKey}:${dayGroup.dateKey}`
                      const isDayExpanded = expandedDays.has(dayKey)
                      return (
                        <div key={dayGroup.dateKey}>
                          <button
                            type="button"
                            onClick={() => toggleDay(dayKey)}
                            className="flex w-full cursor-pointer items-center justify-between px-10 py-1.5 transition-colors hover:bg-[var(--background-elevated)]"
                          >
                            <span className="flex items-center gap-1.5">
                              <ChevronRight
                                size={12}
                                className={cn(
                                  'text-[var(--text-muted)] transition-transform duration-200',
                                  isDayExpanded && 'rotate-90'
                                )}
                              />
                              <span className="text-[11px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
                                {dayGroup.label}
                              </span>
                            </span>
                            <span className="text-[11px] text-[var(--text-muted)]">
                              {dayGroup.sessions.length} session{dayGroup.sessions.length !== 1 ? 's' : ''} · {formatDuration(dayGroup.totalMinutes)}
                            </span>
                          </button>
                          {isDayExpanded && dayGroup.sessions.map((session) => (
                            <React.Fragment key={session.id}>
                              <SessionRow
                                session={session}
                                projectColor={color}
                                isSelected={selectedSessionId === session.id}
                                hasCommits={sessionIdsWithCommits?.has(session.id)}
                                onSelect={(e) => selectSession(session.id, e?.currentTarget)}
                              />
                              {selectedSessionId === session.id && (
                                <SessionDetailPanel
                                  session={session}
                                  projectName={group.projectName}
                                  clientName={group.clientName}
                                  projectColor={color}
                                  onClose={handleCloseDetail}
                                />
                              )}
                            </React.Fragment>
                          ))}
                        </div>
                      )
                    })}
                  </div>
                </ProjectGroup>
              )
            })}
          </div>
        )}
      </div>

      <ManualBlockForm open={showManualForm} onOpenChange={setShowManualForm} />
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
