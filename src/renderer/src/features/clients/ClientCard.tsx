import { useState, useCallback, type KeyboardEvent } from 'react'
import { ChevronRight, Pencil, Trash2 } from 'lucide-react'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger
} from '@/components/ui/collapsible'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
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
import { cn } from '@/lib/utils'
import { ProjectList } from './ProjectList'
import { useDeleteClient } from './use-clients'
import { useProjects } from './use-projects'
import type { Client } from '../../../../shared/types/client-project'

interface ClientCardProps {
  client: Client
  isExpanded: boolean
  onToggle: () => void
  onEdit: () => void
}

export function ClientCard({
  client,
  isExpanded,
  onToggle,
  onEdit
}: ClientCardProps): React.JSX.Element {
  const { data: projects } = useProjects(client.id)
  const deleteClient = useDeleteClient()
  const [deleteOpen, setDeleteOpen] = useState(false)
  const projectCount = projects?.length ?? 0

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault()
        onToggle()
      }
    },
    [onToggle]
  )

  const handleDelete = async (): Promise<void> => {
    try {
      await deleteClient.mutateAsync(client.id)
      toast.success('Client deleted')
      setDeleteOpen(false)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to delete client')
    }
  }

  return (
    <Collapsible open={isExpanded} onOpenChange={onToggle}>
      <CollapsibleTrigger asChild>
        <div
          role="group"
          aria-expanded={isExpanded}
          aria-label={`${client.name} - ${projectCount} projects`}
          tabIndex={0}
          onKeyDown={handleKeyDown}
          className={cn(
            'flex h-12 cursor-pointer items-center gap-3 px-4 transition-colors',
            'hover:bg-[var(--background-elevated)]',
            'focus-visible:outline-2 focus-visible:outline-[var(--accent)]'
          )}
        >
          <ChevronRight
            size={16}
            className={cn(
              'shrink-0 text-[var(--text-muted)] transition-transform duration-200',
              isExpanded && 'rotate-90'
            )}
          />
          <span
            className="h-2 w-2 shrink-0 rounded-full"
            style={{ backgroundColor: client.color }}
          />
          <span className="min-w-0 flex-1 truncate text-[13px] font-semibold">
            {client.name}
          </span>
          {client.billableRate != null && (
            <span
              className="shrink-0 text-[13px] font-bold text-[var(--accent)]"
              title={`$${client.billableRate}/hr`}
            >
              $
            </span>
          )}
          <Badge
            variant="secondary"
            className="shrink-0 bg-[var(--background-elevated)] text-[10px] font-semibold uppercase text-[var(--text-secondary)]"
          >
            {projectCount} {projectCount === 1 ? 'project' : 'projects'}
          </Badge>
          <div className="flex shrink-0 items-center gap-1" onClick={(e) => e.stopPropagation()}>
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={(e) => {
                e.stopPropagation()
                onEdit()
              }}
              aria-label={`Edit ${client.name}`}
            >
              <Pencil size={14} />
            </Button>
            <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
              <AlertDialogTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={(e) => e.stopPropagation()}
                  aria-label={`Delete ${client.name}`}
                  className="text-[var(--text-muted)] hover:text-red-400"
                >
                  <Trash2 size={14} />
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent className="border-[var(--surface-border)] bg-[var(--background-primary)]">
                <AlertDialogHeader>
                  <AlertDialogTitle>Delete client &ldquo;{client.name}&rdquo;?</AlertDialogTitle>
                  <AlertDialogDescription>
                    This will also remove all projects under this client. This action cannot be
                    undone.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel className="border-[var(--surface-border)]">
                    Cancel
                  </AlertDialogCancel>
                  <AlertDialogAction
                    onClick={handleDelete}
                    className="bg-red-600 text-white hover:bg-red-700"
                  >
                    Delete
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </div>
        </div>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <ProjectList clientId={client.id} />
      </CollapsibleContent>
    </Collapsible>
  )
}
