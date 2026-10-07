import type { QueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import type { MarkedFolderEvent, Project } from '../../../../shared/types/client-project'
import { resolveProjectName } from '@/lib/format'

export type FolderSuggestion = Extract<MarkedFolderEvent, { kind: 'suggested' }>

/** Same sources as usePresentationMode, read outside React. */
function presentationMode(qc: QueryClient): boolean {
  const setting = qc.getQueryData<Record<string, string>>(['settings', 'all'])?.presentation_mode
  if (setting !== undefined) return setting === 'true'
  try {
    return localStorage.getItem('presentation-mode') === 'true'
  } catch {
    return false
  }
}

function projectLabel(qc: QueryClient, event: FolderSuggestion, masked: boolean): string {
  const cached = qc
    .getQueriesData<Project[]>({ queryKey: ['projects'] })
    .flatMap(([, projects]) => projects ?? [])
    .find((project) => project.id === event.projectId)
  return resolveProjectName(cached ?? { id: event.projectId, name: event.projectName }, masked)
}

/**
 * Asks whether a folder with a known project's git history belongs to it. Main holds the folder
 * until answered, so the prompt stays until an answer succeeds (or main says it is gone).
 */
export function showFolderSuggestion(event: FolderSuggestion, qc: QueryClient): void {
  const id = `folder-suggestion:${event.directoryPath}`
  const masked = presentationMode(qc)
  const name = projectLabel(qc, event, masked)
  let busy = false
  const answer = async (link: boolean): Promise<void> => {
    if (busy) return
    busy = true
    let keepAsking = false
    try {
      const result = link
        ? await window.api.projects.linkSuggestedFolder(event.projectId, event.directoryPath)
        : await window.api.projects.declineSuggestedFolder(event.directoryPath)
      if (!result.success) {
        toast.error(result.error.message)
        // SUGGESTION_* means main already closed or answered it; anything else can be retried.
        keepAsking = !result.error.code.startsWith('SUGGESTION_')
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
      keepAsking = true
    } finally {
      busy = false
    }
    if (!keepAsking) toast.dismiss(id)
    qc.invalidateQueries({ queryKey: ['projects'] })
    qc.invalidateQueries({ queryKey: ['sessions'] })
  }
  toast(`Is this ${name}?`, {
    id,
    description: masked
      ? `This folder has no ClauTime ID file, but its git history matches ${name}.`
      : `${event.directoryPath} has no ClauTime ID file, but its git history matches ${name}. Link it to track this folder's time there.`,
    duration: Infinity,
    dismissible: false,
    action: {
      label: 'Link',
      onClick: (click) => {
        click.preventDefault()
        void answer(true)
      }
    },
    // A custom element: sonner ignores its built-in cancel button on non-dismissible toasts.
    cancel: (
      <button data-button="" data-cancel="" type="button" onClick={() => void answer(false)}>
        Keep separate
      </button>
    )
  })
}
