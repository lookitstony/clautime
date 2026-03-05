import { useState, useEffect } from 'react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { useCreateProject, useUpdateProject } from './use-projects'
import type { Project } from '../../../../shared/types/client-project'

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

  const [name, setName] = useState('')
  const [directoryPath, setDirectoryPath] = useState('')
  const [isBillable, setIsBillable] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    if (open) {
      if (project) {
        setName(project.name)
        setDirectoryPath(project.directoryPath)
        setIsBillable(project.isBillable)
      } else {
        setName('')
        setDirectoryPath('')
        setIsBillable(true)
      }
      setError('')
    }
  }, [open, project])

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
    if (!trimmedName || !trimmedPath) return

    setError('')

    try {
      if (isEdit && project) {
        await updateProject.mutateAsync({
          id: project.id,
          data: { name: trimmedName, directoryPath: trimmedPath, isBillable }
        })
        toast.success('Project updated')
      } else {
        await createProject.mutateAsync({
          clientId,
          name: trimmedName,
          directoryPath: trimmedPath,
          isBillable
        })
        toast.success('Project created')
      }
      onClose()
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to save project'
      if (message.toLowerCase().includes('unique') || message.toLowerCase().includes('already exists')) {
        setError('A project with this directory path already exists')
      } else {
        toast.error(message)
      }
    }
  }

  const isPending = createProject.isPending || updateProject.isPending
  const isValid = name.trim().length > 0 && directoryPath.trim().length > 0

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-md border-[var(--surface-border)] bg-[var(--background-primary)]">
        <DialogHeader>
          <DialogTitle>{isEdit ? 'Edit Project' : 'Add Project'}</DialogTitle>
          <DialogDescription>
            {isEdit
              ? 'Update the project details.'
              : 'Add a new project to this client.'}
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
            <label htmlFor="project-path" className="text-[13px] font-medium">
              Directory Path
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
                  error
                    ? 'border-red-500'
                    : 'border-[var(--surface-border)]'
                )}
              />
              <Button
                variant="outline"
                onClick={handleBrowse}
                className="shrink-0 border-[var(--surface-border)]"
              >
                Browse
              </Button>
            </div>
            {error && <p className="text-[12px] text-red-400">{error}</p>}
          </div>

          <div className="flex items-center justify-between">
            <label htmlFor="project-billable" className="text-[13px] font-medium">
              Billable
            </label>
            <Switch
              id="project-billable"
              checked={isBillable}
              onCheckedChange={setIsBillable}
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} className="border-[var(--surface-border)]">
            Cancel
          </Button>
          <Button
            onClick={handleSubmit}
            disabled={!isValid || isPending}
            className="bg-[var(--accent)] text-white hover:brightness-[1.15]"
          >
            {isPending ? 'Saving...' : isEdit ? 'Save Changes' : 'Create Project'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
