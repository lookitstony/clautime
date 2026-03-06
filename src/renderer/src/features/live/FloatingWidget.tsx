import { useState, useEffect, useRef } from 'react'
import { Bell, BellOff, Play, Pause, Square, X } from 'lucide-react'
import { QueryClientProvider, useQuery, useQueryClient } from '@tanstack/react-query'
import { queryClient } from '@/lib/query-client'
import { useSetWatching, useLiveBroadcastSync } from './use-live'
import { useLiveStore } from '@/stores/use-live-store'

/** Convert "2h 15m" / "45m" / "3h" to "HH:MM" */
function formatHHMM(dur: string): string {
  const hMatch = dur.match(/(\d+)h/)
  const mMatch = dur.match(/(\d+)m/)
  const h = hMatch ? parseInt(hMatch[1], 10) : 0
  const m = mMatch ? parseInt(mMatch[1], 10) : 0
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
}

function ElapsedTick(): React.JSX.Element {
  const [text, setText] = useState('')
  const activeTimer = useLiveStore((s) => s.activeTimer)
  useEffect(() => {
    const update = (): void => {
      const ms = useLiveStore.getState().getElapsedMs()
      const s = Math.floor(ms / 1000)
      const h = Math.floor(s / 3600)
      const m = Math.floor((s % 3600) / 60)
      const sec = s % 60
      setText(h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`)
    }
    update()
    if (activeTimer?.pausedAt) return
    const id = setInterval(update, 1000)
    return () => clearInterval(id)
  }, [activeTimer?.pausedAt, activeTimer?.startedAt])
  return <>{text}</>
}

function LiveRelative({ epochMs, isProcessing }: { epochMs: number; isProcessing: boolean }): React.JSX.Element {
  const [text, setText] = useState('')
  useEffect(() => {
    if (isProcessing) { setText('00:00'); return }
    const update = (): void => {
      const diffSec = Math.max(0, Math.floor((Date.now() - epochMs) / 1000))
      if (diffSec >= 3600) { setText('idle'); return }
      const m = Math.floor(diffSec / 60)
      const s = diffSec % 60
      setText(`${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`)
    }
    update()
    const id = setInterval(update, 1000)
    return () => clearInterval(id)
  }, [epochMs, isProcessing])
  return <>{text}</>
}

type GlowState = 'processing' | 'prompt-ready' | 'active' | 'nudge' | 'warning' | 'urgent' | 'alert' | 'idle' | 'entrance'

function useGlowState(lastPromptAt: string | null, isProcessing: boolean, warningMin: number, alertMin: number): { state: GlowState; idleSinceMs: number; isActive: boolean } {
  const [state, setState] = useState<GlowState>('entrance')
  const [pastEntrance, setPastEntrance] = useState(false)
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const idleSince = useRef<number>(Date.now())
  // Minimum processing window: once processing is detected, stay purple for at least
  // this long even if isProcessing blips false (covers polling gaps during subagent work)
  const processingUntil = useRef<number>(0)
  const wasProcessing = useRef(false)

  useEffect(() => {
    const t = setTimeout(() => setPastEntrance(true), 1500)
    return () => clearTimeout(t)
  }, [])

  // Extend processing window each time isProcessing is true
  if (isProcessing) {
    processingUntil.current = Date.now() + 10_000
  }

  // Reset idle clock when a new prompt arrives
  useEffect(() => {
    if (lastPromptAt) {
      idleSince.current = Date.now()
    }
  }, [lastPromptAt])

  // Single interval drives all state transitions
  useEffect(() => {
    if (!pastEntrance) return

    const nudgeMin = alertMin * 0.10
    const urgentMin = alertMin * 0.95

    const update = (): void => {
      if (!lastPromptAt) {
        setState('idle')
        wasProcessing.current = false
        return
      }

      const nowProcessing = isProcessing || Date.now() < processingUntil.current

      // Detect processing → idle transition (blue flash)
      if (wasProcessing.current && !nowProcessing) {
        idleSince.current = Date.now()
        setState('prompt-ready')
        if (flashTimer.current) clearTimeout(flashTimer.current)
        flashTimer.current = setTimeout(() => {
          flashTimer.current = null
        }, 1600)
        wasProcessing.current = false
        return
      }

      wasProcessing.current = nowProcessing

      if (nowProcessing) {
        setState('processing')
        return
      }

      // Don't interrupt the blue flash
      if (flashTimer.current) return

      const ageMin = (Date.now() - idleSince.current) / 60_000

      if (ageMin < nudgeMin) {
        setState('active')
      } else if (ageMin < warningMin) {
        setState('nudge')
      } else if (ageMin < urgentMin) {
        setState('warning')
      } else if (ageMin < alertMin) {
        setState('urgent')
      } else {
        setState('alert')
      }
    }

    update()
    const id = setInterval(update, 1000)
    return () => clearInterval(id)
  }, [lastPromptAt, isProcessing, warningMin, alertMin, pastEntrance])

  const nowActive = isProcessing || Date.now() < processingUntil.current
  return { state: pastEntrance ? state : 'entrance', idleSinceMs: idleSince.current, isActive: nowActive }
}

const glowStyles: Record<GlowState, React.CSSProperties> = {
  entrance:     { boxShadow: '0 0 12px 2px rgba(52, 211, 153, 0.5), inset 0 0 8px rgba(52, 211, 153, 0.1)' },
  processing:   { boxShadow: '0 0 16px 3px rgba(168, 85, 247, 0.5), inset 0 0 8px rgba(168, 85, 247, 0.1)', animation: 'glow-breathe 2s ease-in-out infinite' },
  'prompt-ready': { boxShadow: '0 0 18px 4px rgba(96, 165, 250, 0.6), inset 0 0 8px rgba(96, 165, 250, 0.1)', animation: 'glow-prompt-ready 0.8s ease-in-out 2' },
  active:       { boxShadow: '0 0 14px 3px rgba(52, 211, 153, 0.45), inset 0 0 6px rgba(52, 211, 153, 0.08)' },
  nudge:        { boxShadow: '0 0 14px 3px rgba(52, 211, 153, 0.45), inset 0 0 6px rgba(52, 211, 153, 0.08)', animation: 'glow-nudge 1.5s ease-in-out 3' },
  warning:      { boxShadow: '0 0 14px 3px rgba(250, 204, 21, 0.45), inset 0 0 6px rgba(250, 204, 21, 0.08)' },
  urgent:       { boxShadow: '0 0 14px 3px rgba(250, 204, 21, 0.45), inset 0 0 6px rgba(250, 204, 21, 0.08)', animation: 'glow-urgent-pulse 1s ease-in-out infinite' },
  alert:        { boxShadow: '0 0 18px 4px rgba(248, 113, 113, 0.6), inset 0 0 8px rgba(248, 113, 113, 0.1)' },
  idle:         { boxShadow: 'none' }
}

function WidgetContent({ projectId }: { projectId: number }): React.JSX.Element {
  useLiveBroadcastSync()
  const { data: projects } = useQuery({
    queryKey: ['live', 'statuses'],
    queryFn: async () => {
      const result = await window.api.live.getProjectStatuses()
      if (!result.success) throw new Error(result.error.message)
      return result.data
    },
    refetchInterval: 5000
  })
  const activeTimer = useLiveStore((s) => s.activeTimer)
  const setWatching = useSetWatching()
  const qc = useQueryClient()

  const { data: settings } = useQuery({
    queryKey: ['settings', 'all'],
    queryFn: async () => {
      const r = await window.api.settings.getAll()
      return r.success ? r.data : {}
    },
    staleTime: 5_000,
    refetchInterval: 5_000
  })
  const idleTimeout = parseInt(settings?.['idle_timeout_minutes'] ?? '15', 10) || 15
  const alertMode = (settings?.['alert_threshold_mode'] ?? 'percent') as 'percent' | 'minutes'
  const alertThresholdMin = alertMode === 'minutes'
    ? (parseInt(settings?.['alert_threshold_minutes'] ?? '5', 10) || 5)
    : idleTimeout * 0.75

  const project = projects?.find((p) => p.projectId === projectId)
  const isTimerOnThis = activeTimer?.projectId === projectId
  const isTimerOnOther = activeTimer != null && !isTimerOnThis

  const glowEnabled = settings?.['widget_glow_enabled'] !== 'false'
  const { state: rawGlowState, idleSinceMs, isActive } = useGlowState(project?.lastPromptAt ?? null, project?.isProcessing ?? false, alertThresholdMin, idleTimeout)
  const glowState = glowEnabled ? rawGlowState : 'idle' as GlowState

  // Sync theme + accent from main window
  useEffect(() => {
    const applyTheme = (): void => {
      const theme = localStorage.getItem('theme') ?? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
      document.documentElement.setAttribute('data-theme', theme)
    }
    applyTheme()
    window.addEventListener('storage', (e) => {
      if (e.key === 'theme') applyTheme()
    })
  }, [])

  useEffect(() => {
    const accent = settings?.['accent_theme'] ?? 'teal'
    document.documentElement.setAttribute('data-accent', accent)
  }, [settings])

  // Make body transparent, prevent scrollbars, inject glow pulse animation
  useEffect(() => {
    document.documentElement.style.backgroundColor = 'transparent'
    document.documentElement.style.overflow = 'hidden'
    document.body.style.backgroundColor = 'transparent'
    document.body.style.overflow = 'hidden'
    document.body.style.margin = '0'

    const style = document.createElement('style')
    style.textContent = `
      @keyframes glow-breathe {
        0%, 100% { box-shadow: 0 0 16px 3px rgba(168, 85, 247, 0.3), inset 0 0 8px rgba(168, 85, 247, 0.05); }
        50% { box-shadow: 0 0 20px 5px rgba(168, 85, 247, 0.6), inset 0 0 10px rgba(168, 85, 247, 0.15); }
      }
      @keyframes glow-nudge {
        0%, 100% { box-shadow: 0 0 14px 3px rgba(52, 211, 153, 0.45), inset 0 0 6px rgba(52, 211, 153, 0.08); }
        50% { box-shadow: 0 0 6px 1px rgba(52, 211, 153, 0.15), inset 0 0 2px rgba(52, 211, 153, 0.02); }
      }
      @keyframes glow-urgent-pulse {
        0%, 100% { box-shadow: 0 0 14px 3px rgba(250, 204, 21, 0.45), inset 0 0 6px rgba(250, 204, 21, 0.08); }
        50% { box-shadow: 0 0 22px 6px rgba(250, 204, 21, 0.7), inset 0 0 10px rgba(250, 204, 21, 0.15); }
      }
      @keyframes glow-prompt-ready {
        0%, 100% { box-shadow: 0 0 6px 1px rgba(96, 165, 250, 0.15), inset 0 0 2px rgba(96, 165, 250, 0.02); }
        50% { box-shadow: 0 0 22px 5px rgba(96, 165, 250, 0.7), inset 0 0 10px rgba(96, 165, 250, 0.15); }
      }
    `
    document.head.appendChild(style)
    return () => { style.remove() }
  }, [])

  // Refresh on session updates
  useEffect(() => {
    window.api.live.onSessionsUpdated(() => {
      qc.invalidateQueries({ queryKey: ['live'] })
    })
  }, [qc])

  const isPaused = isTimerOnThis && !!activeTimer?.pausedAt

  const handleStart = (): void => {
    if (!project || isTimerOnOther) return
    useLiveStore.getState().startTimer(
      project.projectId,
      project.projectName,
      project.projectPath,
      project.clientId,
      project.clientName
    )
  }

  const handlePauseResume = (): void => {
    if (isPaused) {
      useLiveStore.getState().resumeTimer()
    } else {
      useLiveStore.getState().pauseTimer()
    }
  }

  const handleStop = (): void => {
    window.api.live.showStopDialog(projectId)
  }

  if (!project) {
    return (
      <div className="h-full p-5" style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}>
        <div className="flex h-full items-center justify-center rounded-lg bg-[var(--background-primary)]/90 text-[10px] text-[var(--text-muted)]">
          Loading...
        </div>
      </div>
    )
  }

  return (
    <div className="h-full p-5" style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}>
    <div
      className="h-full rounded-lg border border-[var(--surface-border)]/30 px-2.5 py-1.5 bg-[var(--background-primary)]/90"
      style={{ transition: 'box-shadow 0.6s ease', ...glowStyles[glowState] } as React.CSSProperties}
    >
      {/* Row 1: project name + idle timer + bell + close */}
      <div className="flex items-center gap-1">
        <span className="min-w-0 truncate text-[11px] font-semibold text-[var(--text-primary)]">
          {project.projectName}
        </span>
        <div className="ml-auto flex items-center gap-1">
          <span className="font-mono text-[10px] font-semibold text-[var(--accent)]">
            {project.lastPromptAt ? <LiveRelative epochMs={idleSinceMs} isProcessing={isActive} /> : '—'}
          </span>
          <button
            type="button"
            onClick={() => setWatching.mutate({ projectId: project.projectId, enabled: !project.isWatching })}
            className="shrink-0 p-0.5"
            style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
          >
            {project.isWatching
              ? <Bell size={11} className="text-yellow-400" />
              : <BellOff size={11} className="text-[var(--text-muted)]/40" />}
          </button>
          <button
            type="button"
            onClick={() => window.api.live.toggleWidget(projectId)}
            className="shrink-0 p-0.5 rounded hover:bg-red-500/20"
            style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
          >
            <X size={11} className="text-[var(--text-muted)]" />
          </button>
        </div>
      </div>

      {/* Row 2: stats + timer */}
      <div className="flex items-center justify-between gap-1 mt-0.5">
        <div className="flex items-center gap-1.5 font-mono text-[10px] text-[var(--text-secondary)]">
          <span className="font-bold text-[var(--accent)]">{formatHHMM(project.totalHours)}</span>
          <span>{project.sessionCount}s</span>
          <span>{project.totalPrompts}p</span>
          {project.totalTokens > 0 && <span>{(project.totalTokens / 1000).toFixed(0)}K</span>}
          {project.totalCommits > 0 && <span>{project.totalCommits}c</span>}
        </div>
        {isTimerOnThis ? (
          <div
            className="flex items-center gap-0.5"
            style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
          >
            <button
              type="button"
              onClick={handlePauseResume}
              className={`flex items-center gap-0.5 rounded px-1 py-0.5 font-mono text-[10px] font-semibold ${
                isPaused
                  ? 'bg-emerald-500/15 text-emerald-400'
                  : 'bg-yellow-500/15 text-yellow-400'
              }`}
            >
              {isPaused ? <Play size={8} /> : <Pause size={8} />}
              <ElapsedTick />
            </button>
            <button
              type="button"
              onClick={handleStop}
              className="flex items-center rounded px-1 py-0.5 bg-red-500/15 text-red-400"
            >
              <Square size={8} />
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={handleStart}
            disabled={isTimerOnOther}
            className={`flex items-center gap-0.5 rounded px-1.5 py-0.5 font-mono text-[10px] font-semibold ${
              isTimerOnOther
                ? 'opacity-30 text-[var(--text-muted)]'
                : 'bg-emerald-500/15 text-emerald-400'
            }`}
            style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
          >
            <Play size={8} />
          </button>
        )}
      </div>
    </div>
    </div>
  )
}

export function FloatingWidget(): React.JSX.Element {
  const hash = window.location.hash
  const projectId = parseInt(hash.replace('#widget/', ''), 10)

  return (
    <QueryClientProvider client={queryClient}>
      <WidgetContent projectId={projectId} />
    </QueryClientProvider>
  )
}
