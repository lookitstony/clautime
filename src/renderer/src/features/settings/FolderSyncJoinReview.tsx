import { useEffect, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Button } from '@/components/ui/button'
import { automaticJoinDecisions } from '../../../../shared/folder-sync-matching'
import type {
  FolderSyncJoinDecision,
  FolderSyncJoinReview as Review,
  FolderSyncState
} from '../../../../shared/types/folder-sync'

export function FolderSyncJoinReview({
  onApplied,
  ready = true
}: {
  onApplied(state: FolderSyncState): void
  ready?: boolean
}): React.JSX.Element {
  const review = useQuery({
    queryKey: ['folder-sync', 'join-review'],
    enabled: ready,
    queryFn: async (): Promise<Review> => {
      const result = await window.api.folderSync.joinReview()
      if (!result.success) throw new Error(result.error.message)
      return result.data
    }
  })
  if (!ready && !review.data)
    return <p>Waiting for shared history to finish loading before matching projects.</p>
  if (review.isPending) return <p>Matching projects...</p>
  if (review.error) return <p role="alert">{review.error.message}</p>
  if (!review.data?.required) return <></>
  return (
    <ProjectMatches
      key={review.data.fingerprint}
      data={review.data}
      ready={ready}
      onApplied={onApplied}
      refresh={() => {
        void review.refetch()
      }}
    />
  )
}

function ProjectMatches({
  data,
  ready,
  onApplied,
  refresh
}: {
  data: Review
  ready: boolean
  onApplied(state: FolderSyncState): void
  refresh(): void
}) {
  const [decisions, setDecisions] = useState(() => automaticJoinDecisions(data))
  // null explicitly means this shared project has no folder on this computer.
  const [folders, setFolders] = useState<Record<string, string | null>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const attempted = useRef(false)
  const inferredClients = useRef(new Map<string, FolderSyncJoinDecision>())
  const sharedProjects = data.shared.filter((row) => row.entityType === 'project')
  const linkedLocal = (sharedId: string) => {
    const decision = decisions.find(
      (row) => row.entityType === 'project' && row.action === 'link' && row.sharedId === sharedId
    )
    return data.local.find(
      (row) => row.entityType === 'project' && row.localSyncId === decision?.localSyncId
    )
  }
  const pending = sharedProjects.filter(
    (row) =>
      !(row.entityId in folders) && !row.directoryPath && !linkedLocal(row.entityId)?.directoryPath
  )
  const clientCollisions = data.local.filter(
    (row) =>
      row.entityType === 'client' &&
      decisions.some(
        (decision) =>
          decision.entityType === 'client' &&
          decision.localSyncId === row.localSyncId &&
          decision.action === 'separate' &&
          (!(decision.name ?? row.name).trim() ||
            data.sharedClientNames.includes(decision.name ?? row.name))
      )
  )
  function replace(next: FolderSyncJoinDecision[]) {
    setDecisions((current) =>
      current.map(
        (row) =>
          next.find(
            (item) => item.entityType === row.entityType && item.localSyncId === row.localSyncId
          ) ?? row
      )
    )
  }
  function clearedProjectChoices(sharedId: string): FolderSyncJoinDecision[] {
    const automatic = automaticJoinDecisions(data)
    const next = decisions.map((row) => {
      if (row.entityType !== 'project') return row
      if (row.action === 'link' && row.sharedId !== sharedId) return row
      const original = automatic.find(
        (item) => item.entityType === 'project' && item.localSyncId === row.localSyncId
      )!
      // A displaced automatic identity may now be occupied by another manual choice.
      if (row.action === 'link' && original.action === 'link' && original.sharedId !== sharedId)
        return {
          entityType: 'project' as const,
          localSyncId: row.localSyncId,
          action: 'separate' as const
        }
      return (row.action === 'link' && row.sharedId === sharedId) ||
        (original.action === 'link' && original.sharedId === sharedId)
        ? original
        : row
    })
    return next.map((row) => {
      const previous = row.entityType === 'client' && inferredClients.current.get(row.localSyncId)
      if (!previous) return row
      const needed = next.some(
        (project) =>
          project.entityType === 'project' &&
          project.action === 'link' &&
          data.local.some(
            (local) =>
              local.entityType === 'project' &&
              local.localSyncId === project.localSyncId &&
              local.clientLocalSyncId === row.localSyncId
          )
      )
      return needed ? row : previous
    })
  }
  function saveProjectChoices(next: FolderSyncJoinDecision[]) {
    for (const row of next)
      if (row.entityType === 'client' && row.action === 'separate')
        inferredClients.current.delete(row.localSyncId)
    setDecisions(next)
  }
  function linkProject(sharedId: string, localSyncId: string) {
    if (
      decisions.some(
        (row) =>
          row.entityType === 'project' &&
          row.localSyncId === localSyncId &&
          row.action === 'link' &&
          row.sharedId !== sharedId
      )
    )
      throw new Error('This folder is already matched to another shared project.')
    const local = data.local.find(
      (row) => row.entityType === 'project' && row.localSyncId === localSyncId
    )!
    const shared = sharedProjects.find((row) => row.entityId === sharedId)!
    const cleared = clearedProjectChoices(sharedId)
    const client = cleared.find(
      (row) => row.entityType === 'client' && row.localSyncId === local.clientLocalSyncId
    )
    if (
      shared.localSyncId ||
      !shared.clientSyncId ||
      (local.clientSharedId && local.clientSharedId !== shared.clientSyncId) ||
      (client?.action === 'link' && client.sharedId !== shared.clientSyncId) ||
      cleared.some(
        (row) =>
          row.entityType === 'client' &&
          row.localSyncId !== local.clientLocalSyncId &&
          row.action === 'link' &&
          row.sharedId === shared.clientSyncId
      )
    ) {
      throw new Error(
        'This folder belongs to a project under another client. Choose its matching shared project.'
      )
    }
    if (!local.clientSharedId && client?.action === 'separate')
      inferredClients.current.set(client.localSyncId, client)
    const next = cleared.map((row): FolderSyncJoinDecision => {
      if (row.entityType === 'project' && row.localSyncId === localSyncId)
        return { entityType: 'project', localSyncId, action: 'link', sharedId }
      if (row.entityType === 'project' && row.action === 'link' && row.sharedId === sharedId)
        return { entityType: 'project', localSyncId: row.localSyncId, action: 'separate' }
      if (
        row.entityType === 'client' &&
        row.localSyncId === local.clientLocalSyncId &&
        !local.clientSharedId
      )
        return {
          entityType: 'client',
          localSyncId: row.localSyncId,
          action: 'link',
          sharedId: shared.clientSyncId!
        }
      return row
    })
    saveProjectChoices(next)
    setFolders((current) => {
      const result = { ...current }
      delete result[sharedId]
      return result
    })
  }
  function clearProjectLink(sharedId: string) {
    // Absence of a checkout does not undo a unique identity match. Only discard a manual choice.
    saveProjectChoices(clearedProjectChoices(sharedId))
  }
  async function browse(sharedId: string) {
    setError('')
    try {
      const result = await window.api.dialog.openFolder()
      if (!result.success) throw new Error(result.error.message)
      if (!result.data) return
      const path = result.data
      const local = data.local.find(
        (row) =>
          row.entityType === 'project' &&
          row.directoryPath?.replaceAll('\\', '/').toLowerCase() ===
            path.replaceAll('\\', '/').toLowerCase()
      )
      if (local) linkProject(sharedId, local.localSyncId)
      else {
        // Keep folderless identity matches, but never move an existing checkout implicitly.
        if (linkedLocal(sharedId)?.directoryPath) clearProjectLink(sharedId)
        setFolders((current) => ({ ...current, [sharedId]: path }))
      }
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Could not choose a folder.')
    }
  }
  async function apply() {
    if (!ready) return
    setBusy(true)
    setError('')
    try {
      const result = await window.api.folderSync.applyJoinReview({
        fingerprint: data.fingerprint,
        decisions,
        folders: Object.entries(folders).flatMap(([sharedId, directoryPath]) =>
          directoryPath ? [{ sharedId, directoryPath }] : []
        )
      })
      if (!result.success) {
        if (result.error.code === 'SYNC_JOIN_REVIEW_STALE') refresh()
        throw new Error(result.error.message)
      }
      onApplied(result.data)
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Could not connect projects.')
    } finally {
      setBusy(false)
    }
  }
  // A complete automatic match needs no confirmation screen. Never retry a failed write silently.
  useEffect(() => {
    if (attempted.current || !ready) return
    attempted.current = true
    if (!pending.length && !clientCollisions.length) void apply()
  })
  const unresolved = sharedProjects.filter(
    (row) =>
      !row.directoryPath &&
      !automaticJoinDecisions(data).some(
        (decision) =>
          decision.entityType === 'project' &&
          decision.action === 'link' &&
          decision.sharedId === row.entityId &&
          data.local.some(
            (local) =>
              local.entityType === 'project' &&
              local.localSyncId === decision.localSyncId &&
              local.directoryPath
          )
      )
  )
  return (
    <fieldset
      disabled={!ready || busy}
      aria-label="Map project folders"
      className="space-y-3 rounded border border-[var(--surface-border)] p-3"
    >
      <h3 className="text-sm font-semibold">Map project folders</h3>
      {!ready && <p>Waiting for shared history to finish loading before matching projects.</p>}
      <p className="text-sm">
        Matching projects connect automatically. Choose folders for the remaining shared projects,
        or mark them as not on this computer. Other local projects are added to sync automatically.
      </p>
      {unresolved.map((shared) => {
        const local = linkedLocal(shared.entityId)
        const chosen = folders[shared.entityId]
        const options = data.local.filter(
          (row) =>
            row.entityType === 'project' &&
            (!row.clientSharedId || row.clientSharedId === shared.clientSyncId) &&
            !decisions.some(
              (decision) =>
                decision.entityType === 'project' &&
                decision.localSyncId === row.localSyncId &&
                decision.action === 'link' &&
                decision.sharedId !== shared.entityId
            )
        )
        return (
          <div key={shared.entityId} className="space-y-2 text-sm">
            <p>
              {shared.name ?? 'Project name under review'} (
              {shared.clientName ?? 'Client under review'})
            </p>
            {options.length > 0 && !shared.localSyncId && (
              <select
                aria-label={`Local project for ${shared.name}`}
                value={local?.localSyncId ?? ''}
                disabled={busy}
                onChange={(event) => {
                  try {
                    if (event.target.value) linkProject(shared.entityId, event.target.value)
                    else clearProjectLink(shared.entityId)
                    setError('')
                  } catch (error) {
                    setError(error instanceof Error ? error.message : 'Could not match project.')
                  }
                }}
              >
                <option value="">Choose a local project</option>
                {options.map((row) => (
                  <option key={row.localSyncId} value={row.localSyncId}>
                    {row.name}
                    {row.directoryPath ? ` (${row.directoryPath})` : ''}
                  </option>
                ))}
              </select>
            )}
            <div className="flex gap-2">
              <Button
                variant="outline"
                disabled={busy}
                onClick={() => void browse(shared.entityId)}
              >
                Choose folder for {shared.name}
              </Button>
              <Button
                variant="outline"
                disabled={busy}
                onClick={() => {
                  // A folderless local project's history can be matched without a checkout.
                  // Declining an existing checkout still cancels that tentative folder match.
                  if (linkedLocal(shared.entityId)?.directoryPath) clearProjectLink(shared.entityId)
                  setFolders((current) => ({ ...current, [shared.entityId]: null }))
                }}
              >
                Not on this computer: {shared.name}
              </Button>
            </div>
            {(chosen || local?.directoryPath) && <p>{chosen ?? local?.directoryPath}</p>}
            {chosen === null && <p>History will sync without a local folder.</p>}
          </div>
        )
      })}
      {data.local
        .filter(
          (client) =>
            client.entityType === 'client' &&
            automaticJoinDecisions(data).some(
              (decision) =>
                decision.entityType === 'client' &&
                decision.localSyncId === client.localSyncId &&
                decision.action === 'separate' &&
                data.sharedClientNames.includes(client.name)
            )
        )
        .map((client) => (
          <label key={client.localSyncId} className="block text-sm">
            A shared client is also named {client.name}. Match it or give this local client another
            name.
            <select
              aria-label={`Match client ${client.name}`}
              value=""
              onChange={(event) => {
                inferredClients.current.delete(client.localSyncId)
                if (event.target.value)
                  replace([
                    {
                      entityType: 'client',
                      localSyncId: client.localSyncId,
                      action: 'link',
                      sharedId: event.target.value
                    }
                  ])
              }}
            >
              <option value="">Choose shared client</option>
              {data.shared
                .filter(
                  (row) =>
                    row.entityType === 'client' &&
                    !decisions.some(
                      (decision) =>
                        decision.entityType === 'client' &&
                        decision.action === 'link' &&
                        decision.sharedId === row.entityId
                    )
                )
                .map((row) => (
                  <option key={row.entityId} value={row.entityId}>
                    {row.name}
                  </option>
                ))}
            </select>
            <input
              aria-label={`New client name for ${client.name}`}
              defaultValue={client.name}
              onChange={(event) => {
                inferredClients.current.delete(client.localSyncId)
                replace([
                  {
                    entityType: 'client',
                    localSyncId: client.localSyncId,
                    action: 'separate',
                    name: event.target.value.trim()
                  }
                ])
              }}
            />
          </label>
        ))}
      {error && <p role="alert">{error}</p>}
      <Button
        disabled={!ready || busy || pending.length > 0 || clientCollisions.length > 0}
        onClick={() => void apply()}
      >
        {busy ? 'Connecting projects...' : 'Finish connecting'}
      </Button>
    </fieldset>
  )
}
