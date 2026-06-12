import { useState, useEffect } from 'react'
import { Activity, MonitorUp, MonitorOff } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/shared/EmptyState'
import { LiveStatsBar } from './LiveStatsBar'
import { ProjectWatchList } from './ProjectWatchList'
import { useTodayStats, useProjectStatuses, useTodayCost } from './use-live'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useLiveStore } from '@/stores/use-live-store'
import { useCreateSession } from '@/features/sessions/use-sessions'
import { formatDuration } from '@/lib/format'

export function LivePage(): React.JSX.Element {
  const { data: todayStats, isLoading: statsLoading } = useTodayStats()
  const { data: projectStatuses, isLoading: statusesLoading } = useProjectStatuses()
  const todayCost = useTodayCost()

  const [staleDialog, setStaleDialog] = useState(false)
  const [allWidgetsOpen, setAllWidgetsOpen] = useState(false)
  const activeTimer = useLiveStore((s) => s.activeTimer)
  const isStale = useLiveStore((s) => s.isStale)
  const discardTimer = useLiveStore((s) => s.discardTimer)
  const createSession = useCreateSession()

  useEffect(() => {
    if (isStale()) {
      setStaleDialog(true)
    }
  }, [isStale])

  const handleSaveStale = (): void => {
    // Capture data before clearing state, so error recovery is possible
    if (!activeTimer) return
    const timerData = { ...activeTimer }

    const now = new Date().toISOString()
    const durationMinutes = Math.round((Date.now() - Date.parse(timerData.startedAt)) / 60_000)

    createSession.mutate(
      {
        projectPath: timerData.projectPath,
        startedAt: timerData.startedAt,
        endedAt: now,
        durationMinutes: Math.max(1, durationMinutes),
        description: timerData.description ?? 'Recovered stale timer',
        projectId: timerData.projectId,
        clientId: timerData.clientId
      },
      {
        onSuccess: () => {
          discardTimer()
          setStaleDialog(false)
        }
      }
    )
  }

  const handleDiscardStale = (): void => {
    discardTimer()
    setStaleDialog(false)
  }

  return (
    <div className="flex h-full flex-col">
      <LiveStatsBar stats={todayStats} estimatedCost={todayCost} isLoading={statsLoading} />
      <div className="flex-1 overflow-auto px-4 pb-4">
        <div className="mb-3 flex items-center gap-2">
          <h2 className="text-[14px] font-semibold text-[var(--text-primary)]">Projects</h2>
          {projectStatuses && projectStatuses.length > 0 && (
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={() => {
                    if (allWidgetsOpen) {
                      window.api.live.hideAllWidgets()
                      setAllWidgetsOpen(false)
                    } else {
                      window.api.live.showAllWidgets(projectStatuses.map((p) => p.projectId))
                      setAllWidgetsOpen(true)
                    }
                  }}
                  className="rounded p-1 transition-colors hover:bg-[var(--surface-border)]/50"
                >
                  {allWidgetsOpen ? (
                    <MonitorOff size={16} className="text-[var(--accent)]" />
                  ) : (
                    <MonitorUp
                      size={16}
                      className="text-[var(--text-muted)] hover:text-[var(--accent)]"
                    />
                  )}
                </button>
              </TooltipTrigger>
              <TooltipContent side="right" sideOffset={4}>
                {allWidgetsOpen ? 'Hide all widgets' : 'Show all widgets'}
              </TooltipContent>
            </Tooltip>
          )}
        </div>
        {statusesLoading ? null : projectStatuses && projectStatuses.length > 0 ? (
          <ProjectWatchList projects={projectStatuses} />
        ) : (
          <EmptyState
            icon={Activity}
            title="No activity today"
            description="Start working and sessions will appear automatically."
          />
        )}
      </div>

      {/* Stale timer recovery dialog */}
      <Dialog open={staleDialog} onOpenChange={setStaleDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Stale Timer Found</DialogTitle>
            <DialogDescription>
              A timer for &ldquo;{activeTimer?.projectName}&rdquo; from{' '}
              {activeTimer?.startedAt
                ? new Date(activeTimer.startedAt).toLocaleString()
                : 'unknown'}{' '}
              was still running (
              {activeTimer
                ? formatDuration(
                    Math.round((Date.now() - Date.parse(activeTimer.startedAt)) / 60_000)
                  )
                : ''}
              ). Would you like to save it or discard?
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="destructive" onClick={handleDiscardStale}>
              Discard
            </Button>
            <Button onClick={handleSaveStale}>Save</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
