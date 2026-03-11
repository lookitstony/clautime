import { useState } from 'react'
import { Pencil, FolderOpen, EyeOff } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { ProjectForm } from './ProjectForm'
import { ProjectPicker } from './ProjectPicker'
import { useProjects } from './use-projects'
import { cn } from '@/lib/utils'
import type { Project } from '../../../../shared/types/client-project'

interface ProjectListProps {
  clientId: number
}

export function ProjectList({ clientId }: ProjectListProps): React.JSX.Element {
  const { data: projects, isLoading } = useProjects(clientId)
  const [formOpen, setFormOpen] = useState(false)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [editingProject, setEditingProject] = useState<Project | null>(null)

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

  return (
    <div className="pb-2">
      {!isLoading && (!projects || projects.length === 0) && (
        <p className="px-10 py-2 text-[12px] text-[var(--text-muted)]">No projects yet</p>
      )}

      {projects?.map((project) => (
        <div
          key={project.id}
          className={cn(
            'flex h-10 items-center gap-3 pl-10 pr-4 transition-colors hover:bg-[var(--background-elevated)]',
            !project.isActive && 'opacity-50'
          )}
        >
          <FolderOpen size={14} className="shrink-0 text-[var(--text-muted)]" />
          <span className="min-w-0 flex-1 truncate text-[13px]">{project.name}</span>
          <span className="max-w-[200px] shrink-0 truncate font-mono text-[11px] text-[var(--text-muted)]">
            {project.directoryPath}
          </span>
          {!project.isActive && (
            <Badge
              variant="secondary"
              className="shrink-0 bg-red-500/15 text-[10px] text-red-400"
            >
              <EyeOff size={10} className="mr-1" />
              Excluded
            </Badge>
          )}
          {!project.isBillable && project.isActive && (
            <Badge
              variant="secondary"
              className="shrink-0 bg-[var(--background-elevated)] text-[10px] text-[var(--text-muted)]"
            >
              Non-billable
            </Badge>
          )}
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => handleEditProject(project)}
            aria-label={`Edit ${project.name}`}
          >
            <Pencil size={14} />
          </Button>
        </div>
      ))}

      <div className="flex gap-2 px-10 pt-1">
        <Button variant="ghost" size="sm" onClick={() => setPickerOpen(true)} className="gap-1.5 text-[12px]">
          + Assign Projects
        </Button>
        <Button variant="ghost" size="sm" onClick={handleAddProject} className="gap-1.5 text-[12px]">
          + Add Manually
        </Button>
      </div>

      <ProjectPicker clientId={clientId} open={pickerOpen} onClose={() => setPickerOpen(false)} />

      <ProjectForm
        open={formOpen}
        onClose={handleFormClose}
        clientId={clientId}
        project={editingProject}
      />
    </div>
  )
}
