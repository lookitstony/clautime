import { useState, useEffect, useRef, useCallback } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter
} from '@/components/ui/dialog'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { useCreateProject, useUpdateProject } from './use-projects'
import { useClients } from './use-clients'
import type { Project, ProjectMarkerStatus } from '../../../../shared/types/client-project'

interface ProjectFormProps {
  open: boolean
  onClose: () => void
  clientId: number
  project: Project | null // null = create mode, Project = edit mode
}

export function ProjectForm({
  open,
  onClose,
  clientId,
  project
}: ProjectFormProps): React.JSX.Element {
  const isEdit = project !== null
  const createProject = useCreateProject()
  const updateProject = useUpdateProject()
  const { data: allClients } = useClients()

  const [name, setName] = useState('')
  const [invoiceName, setInvoiceName] = useState('')
  const [stageName, setStageName] = useState('')
  const [hourlyRate, setHourlyRate] = useState('')
  const [directoryPath, setDirectoryPath] = useState('')
  const [isBillable, setIsBillable] = useState(true)
  const [isExcluded, setIsExcluded] = useState(false)
  const [selectedClientId, setSelectedClientId] = useState(clientId)
  const [error, setError] = useState('')
  // Folder sync freshness: the version this editor opened on, kept until the user reloads.
  const [syncVersion, setSyncVersion] = useState<string | undefined>()
  const [stale, setStale] = useState(false)
  // The folder shown when the editor opened; only a changed folder is sent.
  const [openedPath, setOpenedPath] = useState('')
  const openedFor = useRef<string | undefined>(undefined)
  // The .clautime ID file in this computer's folder; null until loaded or without a folder.
  const [marker, setMarker] = useState<{ id: number; status: ProjectMarkerStatus | null }>()
  const [keepInGit, setKeepInGit] = useState(false)
  const queryClient = useQueryClient()

  const load = useCallback(
    (source: Project | null): void => {
      if (source) {
        setName(source.name)
        setInvoiceName(source.invoiceName ?? '')
        setStageName(source.stageName ?? '')
        setHourlyRate(source.hourlyRate != null ? String(source.hourlyRate) : '')
        setDirectoryPath(source.directoryPath ?? '')
        setIsBillable(source.isBillable)
        setIsExcluded(!source.isActive)
        setSelectedClientId(source.clientId)
      } else {
        setName('')
        setInvoiceName('')
        setStageName('')
        setHourlyRate('')
        setDirectoryPath('')
        setIsBillable(true)
        setIsExcluded(false)
        setSelectedClientId(clientId)
      }
      setOpenedPath(source?.directoryPath ?? '')
      setSyncVersion(source?.syncVersion)
      setStale(false)
      setError('')
    },
    [clientId]
  )

  useEffect(() => {
    if (!open) {
      openedFor.current = undefined
      return
    }
    // A query refresh hands in a new object for the same project: keep the draft and its version.
    const key = project ? `project:${project.id}` : `new:${clientId}`
    if (openedFor.current === key) return
    openedFor.current = key
    load(project)
  }, [open, project, clientId, load])

  const projectId = project?.id
  useEffect(() => {
    if (!open || projectId === undefined) return
    let current = true
    window.api.projects.getMarkerStatus(projectId).then((result) => {
      if (!current || !result.success) return
      setMarker({ id: projectId, status: result.data })
      setKeepInGit(result.data?.keepInGit ?? false)
    })
    return () => {
      current = false
    }
  }, [open, projectId])
  const markerStatus = marker && marker.id === projectId ? marker.status : null

  const handleBrowse = async (): Promise<void> => {
    const result = await window.api.dialog.openFolder()
    if (result.success && result.data) {
      setDirectoryPath(result.data)
      setError('')
    }
  }

  const handleSubmit = async (): Promise<void> => {
    const trimmedName = name.trim()
    const trimmedPath = directoryPath.trim()
    if (!trimmedName || (!isEdit && !trimmedPath)) return

    setError('')

    const parsedRate = hourlyRate.trim() === '' ? null : Number(hourlyRate)
    const rate =
      parsedRate != null && Number.isFinite(parsedRate) && parsedRate >= 0 ? parsedRate : null

    try {
      if (isEdit && project) {
        await updateProject.mutateAsync({
          id: project.id,
          data: {
            name: trimmedName,
            invoiceName: invoiceName.trim() || null,
            stageName: stageName.trim() || null,
            hourlyRate: rate,
            ...(trimmedPath !== openedPath && {
              directoryPath: trimmedPath || null
            }),
            isBillable,
            isActive: !isExcluded,
            clientId: selectedClientId,
            ...(syncVersion !== undefined && { expectedSyncVersion: syncVersion })
          }
        })
        if (
          markerStatus?.gitRepo &&
          trimmedPath === openedPath &&
          keepInGit !== markerStatus.keepInGit
        ) {
          const result = await window.api.projects.setMarkerInGit(project.id, keepInGit)
          if (!result.success) toast.error(result.error.message)
        }
        toast.success('Project updated')
      } else {
        await createProject.mutateAsync({
          clientId: selectedClientId,
          name: trimmedName,
          directoryPath: trimmedPath,
          isBillable,
          stageName: stageName.trim() || null,
          hourlyRate: rate
        })
        toast.success('Project created')
      }
      onClose()
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to save project'
      if (message.includes('SYNC_STALE_EDIT')) {
        // Keep the draft; refresh the list so "Load latest" shows what changed.
        setStale(true)
        queryClient.invalidateQueries({ queryKey: ['projects'] })
      } else if (
        message.toLowerCase().includes('unique') ||
        message.toLowerCase().includes('already exists')
      ) {
        setError('A project with this directory path already exists')
      } else {
        toast.error(message)
      }
    }
  }

  const isPending = createProject.isPending || updateProject.isPending
  const isValid = name.trim().length > 0 && (isEdit || directoryPath.trim().length > 0)

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-md border-[var(--surface-border)] bg-[var(--background-primary)]">
        <DialogHeader>
          <DialogTitle>{isEdit ? 'Edit Project' : 'Add Project'}</DialogTitle>
          <DialogDescription>
            {isEdit ? 'Update the project details.' : 'Add a new project to this client.'}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="space-y-2">
            <label htmlFor="project-name" className="text-[13px] font-medium">
              Name
            </label>
            <input
              id="project-name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && isValid) handleSubmit()
              }}
              placeholder="Project name"
              autoFocus
              className={cn(
                'w-full rounded-md border px-3 py-2 text-[13px]',
                'bg-[var(--background-secondary)] text-[var(--text-primary)]',
                'placeholder:text-[var(--text-muted)]',
                'focus:outline-none focus:ring-2 focus:ring-[var(--accent)]',
                'border-[var(--surface-border)]'
              )}
            />
          </div>

          <div className="space-y-2">
            <label htmlFor="project-invoice-name" className="text-[13px] font-medium">
              Invoice Name
            </label>
            <input
              id="project-invoice-name"
              type="text"
              value={invoiceName}
              onChange={(e) => setInvoiceName(e.target.value)}
              placeholder={name || 'Same as project name'}
              className={cn(
                'w-full rounded-md border px-3 py-2 text-[13px]',
                'bg-[var(--background-secondary)] text-[var(--text-primary)]',
                'placeholder:text-[var(--text-muted)]',
                'focus:outline-none focus:ring-2 focus:ring-[var(--accent)]',
                'border-[var(--surface-border)]'
              )}
            />
            <p className="text-[11px] text-[var(--text-muted)]">
              Display name on invoices. Leave blank to use project name.
            </p>
          </div>

          <div className="space-y-2">
            <label htmlFor="project-stage-name" className="text-[13px] font-medium">
              Stage Name
            </label>
            <input
              id="project-stage-name"
              type="text"
              value={stageName}
              onChange={(e) => setStageName(e.target.value)}
              placeholder={name || 'Same as project name'}
              className={cn(
                'w-full rounded-md border px-3 py-2 text-[13px]',
                'bg-[var(--background-secondary)] text-[var(--text-primary)]',
                'placeholder:text-[var(--text-muted)]',
                'focus:outline-none focus:ring-2 focus:ring-[var(--accent)]',
                'border-[var(--surface-border)]'
              )}
            />
            <p className="text-[11px] text-[var(--text-muted)]">
              Shown in place of the real name when Presentation Mode is on (streaming/demos).
            </p>
          </div>

          <div className="space-y-2">
            <label htmlFor="project-hourly-rate" className="text-[13px] font-medium">
              Hourly Rate
            </label>
            <div className="flex items-center gap-2">
              <span className="text-[13px] text-[var(--text-muted)]">$</span>
              <input
                id="project-hourly-rate"
                type="number"
                min={0}
                step="1"
                value={hourlyRate}
                onChange={(e) => setHourlyRate(e.target.value)}
                placeholder="Uses client rate"
                className={cn(
                  'w-full rounded-md border px-3 py-2 text-[13px]',
                  'bg-[var(--background-secondary)] text-[var(--text-primary)]',
                  'placeholder:text-[var(--text-muted)]',
                  'focus:outline-none focus:ring-2 focus:ring-[var(--accent)]',
                  'border-[var(--surface-border)]'
                )}
              />
              <span className="whitespace-nowrap text-[13px] text-[var(--text-muted)]">/hr</span>
            </div>
            <p className="text-[11px] text-[var(--text-muted)]">
              Per-project rate for Earned totals. Leave blank to use the client&apos;s rate.
            </p>
          </div>

          <div className="space-y-2">
            <label htmlFor="project-path" className="text-[13px] font-medium">
              Folder on this computer
            </label>
            <div className="flex gap-2">
              <input
                id="project-path"
                type="text"
                value={directoryPath}
                onChange={(e) => {
                  setDirectoryPath(e.target.value)
                  setError('')
                }}
                placeholder="C:\projects\my-project"
                className={cn(
                  'min-w-0 flex-1 rounded-md border px-3 py-2 font-mono text-[13px]',
                  'bg-[var(--background-secondary)] text-[var(--text-primary)]',
                  'placeholder:text-[var(--text-muted)]',
                  'focus:outline-none focus:ring-2 focus:ring-[var(--accent)]',
                  error ? 'border-red-500' : 'border-[var(--surface-border)]'
                )}
              />
              <Button
                variant="outline"
                onClick={handleBrowse}
                className="shrink-0 border-[var(--surface-border)]"
              >
                {isEdit ? 'Change folder on this computer' : 'Browse'}
              </Button>
            </div>
            {error && <p className="text-[12px] text-red-400">{error}</p>}
            <p className="text-[11px] text-[var(--text-muted)]">
              Changing this folder preserves history and other computers&apos; folders.
              {isEdit && ' Clear it to disconnect the folder on this computer.'}
            </p>
          </div>

          <div className="space-y-2">
            <label htmlFor="project-client" className="text-[13px] font-medium">
              Client
            </label>
            <Select
              value={String(selectedClientId)}
              onValueChange={(v) => setSelectedClientId(Number(v))}
            >
              <SelectTrigger
                id="project-client"
                className="w-full border-[var(--surface-border)] bg-[var(--background-secondary)] text-[13px]"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent position="popper" sideOffset={4}>
                {allClients?.map((c) => (
                  <SelectItem key={c.id} value={String(c.id)}>
                    {c.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="flex items-center justify-between">
            <label htmlFor="project-billable" className="text-[13px] font-medium">
              Billable
            </label>
            <Switch id="project-billable" checked={isBillable} onCheckedChange={setIsBillable} />
          </div>

          <div className="flex items-center justify-between">
            <div>
              <label htmlFor="project-excluded" className="text-[13px] font-medium">
                Exclude from app
              </label>
              <p className="text-[11px] text-[var(--text-muted)]">
                Hide this project from sessions, reports, and live view.
              </p>
            </div>
            <Switch id="project-excluded" checked={isExcluded} onCheckedChange={setIsExcluded} />
          </div>

          {markerStatus?.gitRepo && directoryPath.trim() === openedPath && (
            <div className="flex items-center justify-between gap-4">
              <div>
                <label htmlFor="project-marker-git" className="text-[13px] font-medium">
                  Keep ID file in Git
                </label>
                <p className="text-[11px] text-[var(--text-muted)]">
                  The <code>.clautime</code> file lets a moved folder or a fresh clone find this
                  project. Off keeps it out of Git. On lets you commit it so clones on your other
                  computers link automatically.
                </p>
              </div>
              <Switch id="project-marker-git" checked={keepInGit} onCheckedChange={setKeepInGit} />
            </div>
          )}
        </div>

        {stale && (
          <div className="flex items-center justify-between gap-2 text-[12px] text-amber-400">
            <span>
              This project changed on another computer since you opened it. Your changes are kept
              until you load the latest values.
            </span>
            <Button variant="outline" size="sm" onClick={() => load(project)}>
              Load latest
            </Button>
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={!isValid || isPending || stale}>
            {isPending ? 'Saving...' : isEdit ? 'Save Changes' : 'Create Project'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
