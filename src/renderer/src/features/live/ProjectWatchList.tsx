import { useState, useEffect } from 'react'
import { Bell, BellOff, Play, Pause, Square, MonitorUp, ChevronDown } from 'lucide-react'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger
} from '@/components/ui/tooltip'
import { getProjectColor } from '@/lib/format'
import { useSetWatching, useSetAlertConfig, useAvailableSounds, useSelectCustomSound } from './use-live'
import { useLiveStore } from '@/stores/use-live-store'
import { ManualTimerDialog } from './ManualTimerDialog'
import type { ProjectLiveStatus } from '../../../../shared/types/live'

interface ProjectWatchListProps {
  projects: ProjectLiveStatus[]
}

export function ProjectWatchList({ projects }: ProjectWatchListProps): React.JSX.Element {
  const setWatching = useSetWatching()
  const setAlertConfig = useSetAlertConfig()
  const { data: sounds } = useAvailableSounds()
  const selectCustomSound = useSelectCustomSound()
  const activeTimer = useLiveStore((s) => s.activeTimer)
  const pauseTimer = useLiveStore((s) => s.pauseTimer)
  const resumeTimer = useLiveStore((s) => s.resumeTimer)

  const [timerDialog, setTimerDialog] = useState<{
    open: boolean
    mode: 'start' | 'stop'
    project: ProjectLiveStatus | null
  }>({ open: false, mode: 'start', project: null })

  const handleSoundChange = async (projectId: number, value: string): Promise<void> => {
    if (value === '__custom__') {
      const result = await selectCustomSound.mutateAsync()
      if (result) {
        setAlertConfig.mutate({ projectId, alertSound: result })
      }
    } else {
      setAlertConfig.mutate({ projectId, alertSound: value })
    }
  }

  return (
    <>
      <div
        className="grid gap-2"
        style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))' }}
      >
        {projects.map((project) => (
          <ProjectCard
            key={project.projectId}
            project={project}
            sounds={sounds ?? []}
            activeTimer={activeTimer}
            onToggleWatch={() =>
              setWatching.mutate({
                projectId: project.projectId,
                enabled: !project.isWatching
              })
            }
            onSoundChange={(value) => handleSoundChange(project.projectId, value)}
            onTimerAction={() => {
              const isThisProject = activeTimer?.projectId === project.projectId
              setTimerDialog({
                open: true,
                mode: isThisProject ? 'stop' : 'start',
                project
              })
            }}
            onPauseResume={() => {
              if (activeTimer?.pausedAt) {
                resumeTimer()
              } else {
                pauseTimer()
              }
            }}
          />
        ))}
      </div>

      {timerDialog.project && (
        <ManualTimerDialog
          open={timerDialog.open}
          mode={timerDialog.mode}
          project={timerDialog.project}
          onClose={() => setTimerDialog({ open: false, mode: 'start', project: null })}
        />
      )}
    </>
  )
}

interface ProjectCardProps {
  project: ProjectLiveStatus
  sounds: { name: string; filename: string }[]
  activeTimer: { projectId: number; startedAt: string; pausedAt: string | null } | null
  onToggleWatch: () => void
  onSoundChange: (value: string) => void
  onTimerAction: () => void
  onPauseResume: () => void
}

function ProjectCard({
  project,
  sounds,
  activeTimer,
  onToggleWatch,
  onSoundChange,
  onTimerAction,
  onPauseResume
}: ProjectCardProps): React.JSX.Element {
  const isTimerOnThis = activeTimer?.projectId === project.projectId
  const isTimerOnOther = activeTimer != null && !isTimerOnThis
  const isPaused = isTimerOnThis && !!activeTimer?.pausedAt

  return (
    <Card className="overflow-hidden bg-[var(--background-elevated)] border-[var(--surface-border)] !py-0 !gap-0">
      {/* Header: dot + name/client + popout */}
      <div className="flex items-start gap-2 px-3 pt-2 pb-1">
        <div
          className="mt-1.5 h-2 w-2 shrink-0 rounded-full"
          style={{ backgroundColor: getProjectColor(project.projectPath) }}
        />
        <div className="min-w-0 flex-1">
          <p className="truncate text-[13px] font-semibold text-[var(--text-primary)]">
            {project.projectName}
          </p>
          {project.clientName && (
            <p className="truncate text-[11px] text-[var(--text-secondary)]">
              {project.clientName}
            </p>
          )}
        </div>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={() => window.api.live.toggleWidget(project.projectId)}
              className="mt-0.5 shrink-0 rounded p-1 transition-colors hover:bg-[var(--surface-border)]/50"
            >
              <MonitorUp size={16} className="text-[var(--text-muted)] hover:text-[var(--accent)]" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="top" sideOffset={4}>
            Float always-on-top widget
          </TooltipContent>
        </Tooltip>
      </div>

      {/* Hours — centered */}
      <div className="px-3 py-1 text-center">
        <span className="font-mono text-3xl font-bold text-[var(--accent)]">
          <FormattedDuration value={project.totalHours} />
        </span>
      </div>

      {/* Stats grid row */}
      <div className="grid grid-cols-4 border-t border-[var(--surface-border)]">
        <div className="border-r border-[var(--surface-border)] py-1.5 text-center">
          <div className="font-mono text-[13px] font-semibold text-[var(--text-secondary)]">{project.sessionCount}</div>
          <div className="text-[9px] text-[var(--text-muted)]">sessions</div>
        </div>
        <div className="border-r border-[var(--surface-border)] py-1.5 text-center">
          <div className="font-mono text-[13px] font-semibold text-[var(--text-secondary)]">{project.totalPrompts}</div>
          <div className="text-[9px] text-[var(--text-muted)]">prompts</div>
        </div>
        <div className="border-r border-[var(--surface-border)] py-1.5 text-center">
          <div className="font-mono text-[13px] font-semibold text-[var(--text-secondary)]">
            {project.totalTokens > 0 ? `${(project.totalTokens / 1000).toFixed(0)}K` : '\u2014'}
          </div>
          <div className="text-[9px] text-[var(--text-muted)]">tokens</div>
        </div>
        <div className="py-1.5 text-center">
          <div className="font-mono text-[13px] font-semibold text-[var(--text-secondary)]">
            {project.totalCommits > 0 ? project.totalCommits : '\u2014'}
          </div>
          <div className="text-[9px] text-[var(--text-muted)]">commits</div>
        </div>
      </div>

      {/* Footer: bell + time left, timer right */}
      <div className="flex items-center justify-between border-t border-[var(--surface-border)] px-2 py-1.5">
        <div className="flex items-center gap-1">
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={onToggleWatch}
                className="shrink-0 rounded p-0.5 transition-colors hover:bg-[var(--surface-border)]/50"
                aria-label={project.isWatching ? 'Disable alerts' : 'Enable alerts'}
              >
                {project.isWatching ? (
                  <Bell size={16} className="text-yellow-400" />
                ) : (
                  <BellOff size={16} className="text-[var(--text-muted)]/40" />
                )}
              </button>
            </TooltipTrigger>
            <TooltipContent side="top" sideOffset={4}>
              {project.isWatching ? 'Click to disable alerts' : 'Enable idle alerts'}
            </TooltipContent>
          </Tooltip>

          {project.isWatching && (
            <Select value={project.alertSound} onValueChange={onSoundChange}>
              <SelectTrigger className="h-5 w-5 border-0 bg-transparent p-0 shadow-none [&>svg:last-child]:hidden">
                <ChevronDown size={10} className="text-[var(--text-muted)]" />
              </SelectTrigger>
              <SelectContent position="popper" sideOffset={4} align="start">
                <SelectItem value="system">System</SelectItem>
                <SelectItem value="silent">Silent</SelectItem>
                {sounds.map((s) => (
                  <SelectItem key={s.filename} value={s.filename.replace(/\.\w+$/, '')}>
                    {s.name}
                  </SelectItem>
                ))}
                <SelectItem value="__custom__">Custom...</SelectItem>
              </SelectContent>
            </Select>
          )}

          <span className="text-[10px] text-[var(--text-muted)]">
            {project.lastPromptAt ? <LiveRelativeTime timestamp={project.lastPromptAt} /> : 'idle'}
          </span>
        </div>

        {/* Timer controls — right */}
        <div className="flex items-center gap-1">
          {isTimerOnThis ? (
            <>
              <Button
                variant="ghost"
                onClick={onPauseResume}
                className={`h-7 px-2 text-[11px] font-semibold font-mono ${
                  isPaused
                    ? 'bg-emerald-500/15 text-emerald-400 hover:bg-emerald-500/25 hover:text-emerald-400'
                    : 'bg-yellow-500/15 text-yellow-400 hover:bg-yellow-500/25 hover:text-yellow-400'
                }`}
                aria-label={isPaused ? 'Resume timer' : 'Pause timer'}
              >
                {isPaused ? <Play size={12} /> : <Pause size={12} />}
                <ElapsedInline />
              </Button>
              <Button
                variant="ghost"
                onClick={onTimerAction}
                className="h-7 px-1.5 bg-red-500/15 text-red-400 hover:bg-red-500/25 hover:text-red-400"
                aria-label="Stop timer"
              >
                <Square size={12} />
              </Button>
            </>
          ) : (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  onClick={onTimerAction}
                  disabled={isTimerOnOther}
                  className={`h-6 px-1.5 text-[10px] font-semibold font-mono ${
                    isTimerOnOther
                      ? 'opacity-30'
                      : 'bg-emerald-500/15 text-emerald-400 hover:bg-emerald-500/25 hover:text-emerald-400'
                  }`}
                  aria-label="Start timer"
                >
                  <Play size={10} />
                  Start
                </Button>
              </TooltipTrigger>
              <TooltipContent side="top" sideOffset={4}>
                {isTimerOnOther ? 'Timer running on another project' : 'Start manual timer'}
              </TooltipContent>
            </Tooltip>
          )}
        </div>
      </div>
    </Card>
  )
}

function formatRelativeLive(isoString: string): string {
  const diffMs = Date.now() - new Date(isoString).getTime()
  const diffSec = Math.floor(diffMs / 1000)
  if (diffSec < 60) return 'just now'
  const diffMin = Math.floor(diffSec / 60)
  if (diffMin < 60) return `${diffMin}m ago`
  const diffHours = Math.floor(diffMin / 60)
  const remMin = diffMin % 60
  if (diffHours < 24) return remMin > 0 ? `${diffHours}h ${remMin}m ago` : `${diffHours}h ago`
  return `${Math.floor(diffHours / 24)}d ago`
}

function LiveRelativeTime({ timestamp }: { timestamp: string }): React.JSX.Element {
  const [text, setText] = useState(() => formatRelativeLive(timestamp))

  useEffect(() => {
    setText(formatRelativeLive(timestamp))
    const id = setInterval(() => setText(formatRelativeLive(timestamp)), 30_000)
    return () => clearInterval(id)
  }, [timestamp])

  return <>{text}</>
}

function ElapsedInline(): React.JSX.Element {
  const [elapsed, setElapsed] = useState('')
  const activeTimer = useLiveStore((s) => s.activeTimer)

  useEffect(() => {
    const update = (): void => {
      const ms = useLiveStore.getState().getElapsedMs()
      const totalSec = Math.floor(ms / 1000)
      const h = Math.floor(totalSec / 3600)
      const m = Math.floor((totalSec % 3600) / 60)
      const s = totalSec % 60
      setElapsed(
        h > 0
          ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
          : `${m}:${String(s).padStart(2, '0')}`
      )
    }
    update()
    // Don't tick if paused
    if (activeTimer?.pausedAt) return
    const id = setInterval(update, 1000)
    return () => clearInterval(id)
  }, [activeTimer?.pausedAt, activeTimer?.startedAt])

  return <>{elapsed}</>
}

function FormattedDuration({ value }: { value: string }): React.JSX.Element {
  // value is like "3h 20m", "45m", "2h", "0m"
  const parts = value.match(/(\d+)(h|m)/g)
  if (!parts) return <>{value}</>
  return (
    <>
      {parts.map((part, i) => {
        const match = part.match(/^(\d+)(h|m)$/)
        if (!match) return part
        return (
          <span key={i}>
            {match[1]}
            <span className="text-[0.5em] font-semibold mr-2">{match[2]}</span>
          </span>
        )
      })}
    </>
  )
}
