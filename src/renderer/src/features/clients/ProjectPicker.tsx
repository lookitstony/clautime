import { useState, useCallback } from 'react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter
} from '@/components/ui/dialog'
import { Checkbox } from '@/components/ui/checkbox'
import { Switch } from '@/components/ui/switch'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { toast } from 'sonner'
import { getProjectName } from '@/lib/format'
import { useUnassignedDirectories } from './use-unassigned-directories'
import { useCreateProject, useAttributeSessions } from './use-projects'

interface PickerEntry {
  selected: boolean
  billable: boolean
}

interface ProjectPickerProps {
  clientId: number
  open: boolean
  onClose: () => void
}

export function ProjectPicker({ clientId, open, onClose }: ProjectPickerProps): React.JSX.Element {
  const directories = useUnassignedDirectories()
  const createProject = useCreateProject()
  const attributeSessions = useAttributeSessions()
  const [entries, setEntries] = useState<Map<string, PickerEntry>>(new Map())
  const [assigning, setAssigning] = useState(false)

  const getEntry = useCallback(
    (path: string): PickerEntry => entries.get(path) ?? { selected: false, billable: true },
    [entries]
  )

  const updateEntry = (path: string, patch: Partial<PickerEntry>): void => {
    setEntries((prev) => {
      const next = new Map(prev)
      next.set(path, { ...getEntry(path), ...patch })
      return next
    })
  }

  const selectedCount = Array.from(entries.values()).filter((e) => e.selected).length

  const handleAssign = async (): Promise<void> => {
    if (selectedCount === 0) return
    setAssigning(true)
    try {
      for (const [path, entry] of entries) {
        if (!entry.selected) continue
        await createProject.mutateAsync({
          clientId,
          name: getProjectName(path),
          directoryPath: path,
          isBillable: entry.billable
        })
      }
      await attributeSessions.mutateAsync()
      toast.success(`${selectedCount} project${selectedCount > 1 ? 's' : ''} assigned`)
      setEntries(new Map())
      onClose()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to assign projects')
    } finally {
      setAssigning(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-lg border-[var(--surface-border)] bg-[var(--background-primary)]">
        <DialogHeader>
          <DialogTitle>Assign Discovered Projects</DialogTitle>
          <DialogDescription>
            Select projects to assign to this client. Toggle billable per project.
          </DialogDescription>
        </DialogHeader>

        {directories.length === 0 ? (
          <p className="py-4 text-center text-[13px] text-[var(--text-muted)]">
            No unassigned projects found.
          </p>
        ) : (
          <div className="max-h-[360px] space-y-1 overflow-y-auto py-2">
            {directories.map((dir) => {
              const entry = getEntry(dir.path)
              return (
                <div
                  key={dir.path}
                  className="flex items-center gap-3 rounded px-2 py-2 transition-colors hover:bg-[var(--background-elevated)]"
                >
                  <Checkbox
                    checked={entry.selected}
                    onCheckedChange={(v) => updateEntry(dir.path, { selected: !!v })}
                    aria-label={`Select ${dir.name}`}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[13px]">{dir.name}</div>
                    <div className="truncate font-mono text-[11px] text-[var(--text-muted)]">
                      {dir.path}
                    </div>
                  </div>
                  <Badge
                    variant="secondary"
                    className="shrink-0 bg-[var(--background-elevated)] text-[10px] text-[var(--text-muted)]"
                  >
                    {dir.sessionCount} {dir.sessionCount === 1 ? 'session' : 'sessions'}
                  </Badge>
                  <span className="shrink-0 text-[11px] text-[var(--text-muted)]">Billable</span>
                  <Switch
                    checked={entry.billable}
                    onCheckedChange={(v) => updateEntry(dir.path, { billable: v })}
                    aria-label={`Billable ${dir.name}`}
                  />
                </div>
              )
            })}
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            onClick={handleAssign}
            disabled={selectedCount === 0 || assigning}
          >
            {assigning
              ? 'Assigning...'
              : selectedCount > 0
                ? `Assign ${selectedCount} Project${selectedCount > 1 ? 's' : ''}`
                : 'Assign Projects'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
