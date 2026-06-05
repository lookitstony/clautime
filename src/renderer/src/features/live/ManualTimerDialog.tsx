import { useState, useEffect } from 'react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { useLiveStore } from '@/stores/use-live-store'
import { useCreateSession } from '@/features/sessions/use-sessions'
import { formatDuration } from '@/lib/format'
import type { ProjectLiveStatus } from '../../../../shared/types/live'

interface ManualTimerDialogProps {
  open: boolean
  mode: 'start' | 'stop'
  project: ProjectLiveStatus
  onClose: () => void
}

export function ManualTimerDialog({
  open,
  mode,
  project,
  onClose
}: ManualTimerDialogProps): React.JSX.Element {
  if (mode === 'start') {
    return <StartTimerDialog open={open} project={project} onClose={onClose} />
  }
  return <StopTimerDialog open={open} project={project} onClose={onClose} />
}

function StartTimerDialog({
  open,
  project,
  onClose
}: {
  open: boolean
  project: ProjectLiveStatus
  onClose: () => void
}): React.JSX.Element {
  const [description, setDescription] = useState('')
  const startTimer = useLiveStore((s) => s.startTimer)

  const handleStart = (): void => {
    startTimer(
      project.projectId,
      project.projectName,
      project.projectPath,
      project.clientId,
      project.clientName,
      description || null
    )
    setDescription('')
    onClose()
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Start Timer</DialogTitle>
          <DialogDescription>Track manual work on {project.projectName}</DialogDescription>
        </DialogHeader>
        <div>
          <label className="mb-1.5 block text-[13px] text-[var(--text-muted)]">
            Description (optional)
          </label>
          <input
            type="text"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="What are you working on?"
            className="w-full rounded-md border border-[var(--surface-border)] bg-[var(--background-primary)] px-3 py-2 text-sm text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
          />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={handleStart}>Start</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function StopTimerDialog({
  open,
  project,
  onClose
}: {
  open: boolean
  project: ProjectLiveStatus
  onClose: () => void
}): React.JSX.Element {
  const activeTimer = useLiveStore((s) => s.activeTimer)
  const stopTimer = useLiveStore((s) => s.stopTimer)
  const discardTimer = useLiveStore((s) => s.discardTimer)
  const createSession = useCreateSession()

  const [description, setDescription] = useState(activeTimer?.description ?? '')
  const [elapsed, setElapsed] = useState('')

  const hadDescriptionAtStart = !!activeTimer?.description
  const descriptionRequired = !hadDescriptionAtStart
  const canSave = description.trim().length > 0

  useEffect(() => {
    if (!activeTimer) return
    const update = (): void => {
      const ms = useLiveStore.getState().getElapsedMs()
      const minutes = Math.round(ms / 60_000)
      setElapsed(formatDuration(minutes))
    }
    update()
    const id = setInterval(update, 1000)
    return () => clearInterval(id)
  }, [activeTimer])

  const handleSave = (): void => {
    const elapsedMs = useLiveStore.getState().getElapsedMs()
    const timer = stopTimer()
    if (!timer) return

    const now = new Date().toISOString()
    const durationMinutes = Math.round(elapsedMs / 60_000)

    createSession.mutate({
      projectPath: timer.projectPath,
      startedAt: timer.startedAt,
      endedAt: now,
      durationMinutes: Math.max(1, durationMinutes),
      description: description.trim(),
      projectId: timer.projectId,
      clientId: timer.clientId
    })
    onClose()
  }

  const handleDiscard = (): void => {
    discardTimer()
    onClose()
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Stop Timer</DialogTitle>
          <DialogDescription>
            {project.projectName} &mdash; {elapsed}
          </DialogDescription>
        </DialogHeader>
        <div>
          <label className="mb-1.5 block text-[13px] text-[var(--text-muted)]">
            Description{descriptionRequired ? ' (required)' : ''}
          </label>
          <input
            type="text"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="What did you work on?"
            className={`w-full rounded-md border bg-[var(--background-primary)] px-3 py-2 text-sm text-[var(--text-primary)] outline-none focus:border-[var(--accent)] ${
              descriptionRequired && !canSave ? 'border-red-500' : 'border-[var(--surface-border)]'
            }`}
          />
          {descriptionRequired && !canSave && (
            <p className="mt-1 text-[11px] text-red-400">Description is required</p>
          )}
        </div>
        <DialogFooter>
          <Button variant="destructive" onClick={handleDiscard}>
            Discard
          </Button>
          <Button onClick={handleSave} disabled={!canSave}>
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
