import { useState, useCallback, type ChangeEvent, type FormEvent } from 'react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter
} from '@/components/ui/dialog'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { useClients } from '../clients/use-clients'
import { useProjects } from '../clients/use-projects'
import { usePresentationMode } from '../settings/use-presentation-mode'
import { resolveClientName, resolveProjectName } from '@/lib/format'
import { useCreateSession } from './use-sessions'
import type { Project } from '../../../../shared/types/client-project'

interface ManualBlockFormProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

function getTodayString(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function toIso(dateStr: string, timeStr: string): string | null {
  const parts = timeStr.split(':').map(Number)
  if (parts.length < 2 || parts.some(isNaN)) return null
  const [h, m, s = 0] = parts
  if (h < 0 || h > 23 || m < 0 || m > 59 || s < 0 || s > 59) return null
  const dateParts = dateStr.split('-').map(Number)
  if (dateParts.length !== 3) return null
  const [y, mo, day] = dateParts
  const d = new Date(y, mo - 1, day, h, m, s)
  return d.toISOString()
}

export function ManualBlockForm({ open, onOpenChange }: ManualBlockFormProps): React.JSX.Element {
  const { data: clients } = useClients()
  const { data: allProjects } = useProjects()
  const presentationMode = usePresentationMode()
  const createSession = useCreateSession()

  const [projectId, setProjectId] = useState<string>('')
  const [date, setDate] = useState(getTodayString())
  const [startTime, setStartTime] = useState('')
  const [endTime, setEndTime] = useState('')
  const [description, setDescription] = useState('')
  const [error, setError] = useState<string | null>(null)

  const resetForm = useCallback(() => {
    setProjectId('')
    setDate(getTodayString())
    setStartTime('')
    setEndTime('')
    setDescription('')
    setError(null)
  }, [])

  const handleClose = useCallback(
    (isOpen: boolean) => {
      if (!isOpen) {
        // Check for dirty state
        const isDirty = projectId || startTime || endTime || description
        if (isDirty) {
          // Simple check — in production you might want a confirmation
          // For now just close
        }
        resetForm()
      }
      onOpenChange(isOpen)
    },
    [onOpenChange, resetForm, projectId, startTime, endTime, description]
  )

  const handleSubmit = useCallback(
    (e: FormEvent) => {
      e.preventDefault()
      setError(null)

      if (!projectId) {
        setError('Please select a project')
        return
      }
      if (!startTime || !endTime) {
        setError('Start and end times are required')
        return
      }

      const startIso = toIso(date, startTime)
      const endIso = toIso(date, endTime)
      if (!startIso || !endIso) {
        setError('Invalid time format (use HH:MM or HH:MM:SS)')
        return
      }

      if (new Date(endIso).getTime() <= new Date(startIso).getTime()) {
        setError('End time must be after start time')
        return
      }

      const durationMinutes = Math.round(
        (new Date(endIso).getTime() - new Date(startIso).getTime()) / 60_000
      )

      const project = allProjects?.find((p) => p.id === parseInt(projectId, 10))

      createSession.mutate(
        {
          projectPath: project?.directoryPath ?? 'manual',
          startedAt: startIso,
          endedAt: endIso,
          durationMinutes,
          description: description || undefined,
          projectId: project?.id ?? null,
          clientId: project?.clientId ?? null
        },
        {
          onSuccess: () => {
            resetForm()
            onOpenChange(false)
          },
          onError: (err) => {
            setError(err.message)
          }
        }
      )
    },
    [
      projectId,
      date,
      startTime,
      endTime,
      description,
      allProjects,
      createSession,
      resetForm,
      onOpenChange
    ]
  )

  const isValid = projectId && startTime && endTime

  // Group projects by client
  const projectsByClient = allProjects?.reduce(
    (acc, p) => {
      const client = clients?.find((c) => c.id === p.clientId)
      const key = client ? resolveClientName(client, presentationMode) : 'Unknown'
      if (!acc[key]) acc[key] = []
      acc[key].push(p)
      return acc
    },
    {} as Record<string, Project[]>
  )

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="bg-[var(--background-elevated)] sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Add Manual Time Block</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit}>
          <div className="space-y-4 py-4">
            {/* Project */}
            <div>
              <label className="mb-1 block text-[12px] font-semibold text-[var(--text-muted)]">
                Project
              </label>
              <Select value={projectId} onValueChange={setProjectId}>
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="Select a project..." />
                </SelectTrigger>
                <SelectContent position="popper">
                  {projectsByClient &&
                    Object.entries(projectsByClient).map(([clientName, projects]) => (
                      <SelectGroup key={clientName}>
                        <SelectLabel>{clientName}</SelectLabel>
                        {projects.map((p) => (
                          <SelectItem key={p.id} value={p.id.toString()}>
                            {resolveProjectName(p, presentationMode)}
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    ))}
                </SelectContent>
              </Select>
            </div>

            {/* Date */}
            <div>
              <label className="mb-1 block text-[12px] font-semibold text-[var(--text-muted)]">
                Date
              </label>
              <input
                type="date"
                value={date}
                onChange={(e: ChangeEvent<HTMLInputElement>) => setDate(e.target.value)}
                className="w-full rounded border border-[var(--surface-border)] bg-[var(--background-primary)] px-3 py-2 text-[13px] text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
              />
            </div>

            {/* Time range */}
            <div className="flex gap-3">
              <div className="flex-1">
                <label className="mb-1 block text-[12px] font-semibold text-[var(--text-muted)]">
                  Start Time
                </label>
                <input
                  type="text"
                  value={startTime}
                  onChange={(e: ChangeEvent<HTMLInputElement>) => {
                    setStartTime(e.target.value)
                    setError(null)
                  }}
                  placeholder="HH:MM"
                  className="w-full rounded border border-[var(--surface-border)] bg-[var(--background-primary)] px-3 py-2 font-mono text-[13px] text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
                />
              </div>
              <div className="flex-1">
                <label className="mb-1 block text-[12px] font-semibold text-[var(--text-muted)]">
                  End Time
                </label>
                <input
                  type="text"
                  value={endTime}
                  onChange={(e: ChangeEvent<HTMLInputElement>) => {
                    setEndTime(e.target.value)
                    setError(null)
                  }}
                  placeholder="HH:MM"
                  className="w-full rounded border border-[var(--surface-border)] bg-[var(--background-primary)] px-3 py-2 font-mono text-[13px] text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
                />
              </div>
            </div>

            {/* Description */}
            <div>
              <label className="mb-1 block text-[12px] font-semibold text-[var(--text-muted)]">
                Description
              </label>
              <textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="What did you work on?"
                rows={2}
                className="w-full rounded border border-[var(--surface-border)] bg-[var(--background-primary)] px-3 py-2 text-[13px] text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
              />
            </div>

            {error && <p className="text-[12px] text-[var(--destructive)]">{error}</p>}
          </div>

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => handleClose(false)}>
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={!isValid || createSession.isPending}
              className="bg-[var(--accent)] text-white hover:brightness-[1.15]"
            >
              {createSession.isPending ? 'Saving...' : 'Add Block'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
