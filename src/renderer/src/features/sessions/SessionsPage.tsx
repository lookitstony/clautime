import { useState, useCallback } from 'react'
import { AlertTriangle, LayoutList } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { EmptyState } from '@/components/shared/EmptyState'
import { StatsBar } from './StatsBar'
import { ProjectGroup } from './ProjectGroup'
import { SessionRow } from './SessionRow'
import { useSessions, useScanSessions, useSessionStats, useGroupedSessions } from './use-sessions'
import { getProjectColor } from '@/lib/format'

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
  const scanMutation = useScanSessions()
  const stats = useSessionStats(sessions)
  const groups = useGroupedSessions(sessions)

  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set())
  const [selectedSessionId, setSelectedSessionId] = useState<number | null>(null)

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

  const handleScan = useCallback(() => {
    scanMutation.mutate()
  }, [scanMutation])

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
            description="Run a scan to detect your Claude Code sessions"
            action={
              <Button
                onClick={handleScan}
                disabled={scanMutation.isPending}
                className="bg-[var(--accent)] text-white hover:brightness-[1.15]"
              >
                {scanMutation.isPending ? 'Scanning...' : 'Scan Now'}
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
                  {group.sessions.map((session) => (
                    <SessionRow
                      key={session.id}
                      session={session}
                      projectColor={getProjectColor(group.projectPath)}
                      isSelected={selectedSessionId === session.id}
                      onSelect={() => selectSession(session.id)}
                    />
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
