import { useState } from 'react'
import { Pencil, Trash2, FolderOpen } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger
} from '@/components/ui/alert-dialog'
import { toast } from 'sonner'
import { ProjectForm } from './ProjectForm'
import { useProjects, useDeleteProject } from './use-projects'
import type { Project } from '../../../../shared/types/client-project'

interface ProjectListProps {
  clientId: number
}

export function ProjectList({ clientId }: ProjectListProps): React.JSX.Element {
  const { data: projects, isLoading } = useProjects(clientId)
  const deleteProject = useDeleteProject()
  const [formOpen, setFormOpen] = useState(false)
  const [editingProject, setEditingProject] = useState<Project | null>(null)
  const [deleteTargetId, setDeleteTargetId] = useState<number | null>(null)

  const handleAddProject = (): void => {
    setEditingProject(null)
    setFormOpen(true)
  }

  const handleEditProject = (project: Project): void => {
    setEditingProject(project)
    setFormOpen(true)
  }

  const handleFormClose = (): void => {
    setFormOpen(false)
    setEditingProject(null)
  }

  const handleDeleteProject = async (project: Project): Promise<void> => {
    try {
      await deleteProject.mutateAsync(project.id)
      toast.success('Project deleted')
      setDeleteTargetId(null)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to delete project')
    }
  }

  return (
    <div className="pb-2">
      {!isLoading && (!projects || projects.length === 0) && (
        <p className="px-10 py-2 text-[12px] text-[var(--text-muted)]">No projects yet</p>
      )}

      {projects?.map((project) => (
        <div
          key={project.id}
          className="flex h-10 items-center gap-3 pl-10 pr-4 transition-colors hover:bg-[var(--background-elevated)]"
        >
          <FolderOpen size={14} className="shrink-0 text-[var(--text-muted)]" />
          <span className="min-w-0 flex-1 truncate text-[13px]">{project.name}</span>
          <span className="max-w-[200px] shrink-0 truncate font-mono text-[11px] text-[var(--text-muted)]">
            {project.directoryPath}
          </span>
          {!project.isBillable && (
            <Badge
              variant="secondary"
              className="shrink-0 bg-[var(--background-elevated)] text-[10px] text-[var(--text-muted)]"
            >
              Non-billable
            </Badge>
          )}
          <div className="flex shrink-0 items-center gap-1">
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => handleEditProject(project)}
              aria-label={`Edit ${project.name}`}
            >
              <Pencil size={14} />
            </Button>
            <AlertDialog
              open={deleteTargetId === project.id}
              onOpenChange={(v) => setDeleteTargetId(v ? project.id : null)}
            >
              <AlertDialogTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Delete ${project.name}`}
                  className="text-[var(--text-muted)] hover:text-red-400"
                >
                  <Trash2 size={14} />
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent className="border-[var(--surface-border)] bg-[var(--background-primary)]">
                <AlertDialogHeader>
                  <AlertDialogTitle>Delete project &ldquo;{project.name}&rdquo;?</AlertDialogTitle>
                  <AlertDialogDescription>
                    This action cannot be undone.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel className="border-[var(--surface-border)]">
                    Cancel
                  </AlertDialogCancel>
                  <AlertDialogAction
                    onClick={() => handleDeleteProject(project)}
                    className="bg-red-600 text-white hover:bg-red-700"
                  >
                    Delete
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </div>
        </div>
      ))}

      <div className="px-10 pt-1">
        <Button variant="ghost" size="sm" onClick={handleAddProject} className="gap-1.5 text-[12px]">
          + Add Project
        </Button>
      </div>

      <ProjectForm
        open={formOpen}
        onClose={handleFormClose}
        clientId={clientId}
        project={editingProject}
      />
    </div>
  )
}
