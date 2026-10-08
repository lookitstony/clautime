import { SyncConflictReview } from './SyncConflictReview'
import { FolderSyncJoinReview } from './FolderSyncJoinReview'
import { useCallback, useEffect, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Button } from '@/components/ui/button'
import type { FolderSyncState, SharedHistoryChoice } from '../../../../shared/types/folder-sync'
import type { SourceMachineSummary } from '../../../../shared/types/source-machine'

const statusText: Record<FolderSyncState['status'], string> = {
  disabled: 'Transfers paused',
  idle: 'Local folder checked',
  incomplete: 'Some history needs attention',
  'update-required': 'Update ClauTime to continue syncing',
  unavailable: 'Shared folder unavailable'
}
function MachineName({ machine, saved }: { machine: SourceMachineSummary; saved(): void }) {
  const [name, setName] = useState(machine.label)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  return (
    <form
      className="space-y-2"
      onSubmit={async (event) => {
        event.preventDefault()
        setBusy(true)
        setError('')
        try {
          const result = await window.api.machines.rename({
            deviceId: machine.deviceId,
            name,
            observedHeads: machine.labelHeads
          })
          if (!result.success) throw new Error(result.error.message)
          saved()
        } catch (error) {
          setError(error instanceof Error ? error.message : 'Could not save computer name.')
        } finally {
          setBusy(false)
        }
      }}
    >
      <label className="flex flex-wrap items-center gap-2 text-sm">
        <span>
          {machine.isThisComputer ? 'This computer' : 'Computer'}
          {machine.duplicateLabel ? ` (${machine.deviceId.slice(0, 8)})` : ''}
        </span>
        <input
          aria-label={`Computer name ${machine.deviceId}`}
          className="rounded border border-[var(--surface-border)] bg-transparent px-2 py-1"
          value={name}
          maxLength={120}
          onChange={(event) => setName(event.target.value)}
        />
        <Button type="submit" variant="outline" disabled={busy || !name.trim()}>
          {machine.labelBasis === 'conflict' ? 'Resolve name' : 'Save name'}
        </Button>
      </label>
      {machine.alternatives.length > 0 && (
        <p className="text-sm">
          Names changed on different computers: {machine.alternatives.join(', ')}. Saving resolves
          these alternatives.
        </p>
      )}
      {error && <p role="alert">{error}</p>}
    </form>
  )
}

export function FolderSyncSettings(): React.JSX.Element {
  const cache = useQueryClient()
  const state = useQuery({
    queryKey: ['folder-sync'],
    queryFn: async () => {
      const result = await window.api.folderSync.status()
      if (!result.success) throw new Error(result.error.message)
      return result.data
    },
    refetchInterval: (query) => (query.state.data?.progress ? 1_000 : 5_000)
  })
  const machines = useQuery({
    queryKey: ['machines'],
    queryFn: async () => {
      const result = await window.api.machines.list()
      if (!result.success) throw new Error(result.error.message)
      return result.data
    },
    enabled: !!state.data?.connected
  })
  const [folder, setFolder] = useState('')
  const [choices, setChoices] = useState<SharedHistoryChoice[]>([])
  const [selected, setSelected] = useState('')
  const [emptyFolder, setEmptyFolder] = useState(false)
  const [pendingActions, setPendingActions] = useState(0)
  const busy = pendingActions > 0
  const [error, setError] = useState('')
  const run = useCallback(async (action: () => Promise<void>) => {
    setPendingActions((count) => count + 1)
    setError('')
    try {
      await action()
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Sync could not finish.')
    } finally {
      setPendingActions((count) => count - 1)
    }
  }, [])
  const received = useCallback(
    (next: FolderSyncState) => {
      cache.setQueryData(['folder-sync'], next)
      void cache.invalidateQueries({ queryKey: ['folder-sync', 'conflicts'] })
      void cache.invalidateQueries({ queryKey: ['folder-sync', 'join-review'] })
      for (const key of [
        'sessions',
        'clients',
        'projects',
        'invoices',
        'machines',
        'workspace-policy',
        'reports',
        'local-project-setup'
      ])
        void cache.invalidateQueries({ queryKey: [key] })
    },
    [cache]
  )
  async function chooseFolder() {
    const chosen = await window.api.dialog.openFolder()
    if (!chosen.success) throw new Error(chosen.error.message)
    if (!chosen.data) return
    setFolder(chosen.data)
    setSelected('')
    setChoices([])
    setEmptyFolder(false)
    await checkFolder(chosen.data)
  }
  const checkFolder = useCallback(
    async function checkFolder(path: string, startNew = false) {
      setEmptyFolder(false)
      const found = await window.api.folderSync.discover(path)
      if (!found.success) throw new Error(found.error.message)
      if (found.data.issues.length)
        throw new Error(found.data.issues.map((issue) => issue.message).join(' '))
      setChoices(found.data.workspaces)
      if (found.data.workspaces.length > 1) return
      if (!found.data.workspaces.length && !startNew) {
        setEmptyFolder(true)
        return
      }
      const result = await window.api.folderSync.connect(
        found.data.workspaces.length
          ? { mode: 'join', folder: path, workspaceId: found.data.workspaces[0].workspaceId }
          : { mode: 'create', folder: path }
      )
      if (!result.success && result.error.code === 'SYNC_HISTORY_ARRIVED') {
        await checkFolder(path)
        return
      }
      if (!result.success) throw new Error(result.error.message)
      received(result.data)
    },
    [received]
  )
  const connected = state.data?.connected
  useEffect(() => {
    if (!folder || connected || busy || choices.length) return
    const timer = setTimeout(() => void run(() => checkFolder(folder)), 3_000)
    return () => clearTimeout(timer)
  }, [folder, connected, busy, choices.length, run, checkFolder])
  return (
    <section className="space-y-3 rounded-lg border border-[var(--surface-border)] bg-[var(--background-elevated)] p-4">
      <h2 className="text-[14px] font-semibold">Shared history</h2>
      <p className="text-sm text-[var(--text-muted)]">
        Use a folder already synced by Google Drive, OneDrive, or another file-sync provider. Each
        computer keeps its own database and works offline.
      </p>
      {state.isPending && <p>Loading sync settings...</p>}
      {(state.error || error) && (
        <p role="alert" className="text-sm">
          {error || state.error?.message}
        </p>
      )}
      {connected && state.data ? (
        <>
          <p className="text-sm font-medium">
            {state.data.name ?? 'Shared history'}: {statusText[state.data.status]}
          </p>
          <p className="break-all text-sm">{state.data.folder}</p>
          {state.data.progress && (
            <p role="status" className="text-sm">
              {state.data.progress.stage}...
              {state.data.progress.completed > 0 &&
                ` ${state.data.progress.completed.toLocaleString()} processed.`}
            </p>
          )}
          <p className="text-sm">
            {state.data.pending} change(s) waiting to publish. A local folder check does not confirm
            cloud delivery or that another computer is current.
          </p>
          <div className="flex gap-2">
            <Button
              disabled={busy || !!state.data.progress || !state.data.enabled}
              onClick={() =>
                void run(async () => {
                  const result = await window.api.folderSync.syncNow()
                  if (!result.success) throw new Error(result.error.message)
                  received(result.data)
                })
              }
            >
              Sync now
            </Button>
            <Button
              variant="outline"
              disabled={busy && !state.data.progress}
              onClick={() =>
                void run(async () => {
                  const result = await window.api.folderSync.setEnabled(!state.data!.enabled)
                  if (!result.success) throw new Error(result.error.message)
                  received(result.data)
                })
              }
            >
              {state.data.enabled ? 'Pause transfers' : 'Resume transfers'}
            </Button>
            <Button
              variant="outline"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  const chosen = await window.api.dialog.openFolder()
                  if (!chosen.success) throw new Error(chosen.error.message)
                  if (!chosen.data) return
                  const found = await window.api.folderSync.discover(chosen.data)
                  if (!found.success) throw new Error(found.error.message)
                  if (
                    !found.data.workspaces.some(
                      (history) => history.workspaceId === state.data!.workspaceId
                    )
                  )
                    throw new Error(
                      'The selected folder does not contain this shared history. Wait for your file-sync provider to finish copying it.'
                    )
                  const result = await window.api.folderSync.connect({
                    mode: 'join',
                    folder: chosen.data,
                    workspaceId: state.data!.workspaceId!
                  })
                  if (!result.success) throw new Error(result.error.message)
                  received(result.data)
                })
              }
            >
              Change folder location
            </Button>
          </div>
          <p className="text-sm text-[var(--text-muted)]">
            Pausing retains your history and records local edits for later transfer.
          </p>
          {state.data.joinReviewRequired && (
            <FolderSyncJoinReview
              onApplied={received}
              ready={!state.data.progress && state.data.joinReviewReady !== false}
            />
          )}
          {state.data.issues.length > 0 && (
            <ul className="list-disc space-y-1 pl-5 text-sm" aria-label="Sync issues">
              {state.data.issues.map((issue, index) => (
                <li key={`${issue.code}:${index}`}>{issue.message}</li>
              ))}
            </ul>
          )}
          <SyncConflictReview />
          {machines.error && <p role="alert">{machines.error.message}</p>}
          {machines.data?.map((machine) => (
            <MachineName
              key={`${machine.deviceId}:${JSON.stringify(machine.labelHeads)}`}
              machine={machine}
              saved={() => {
                void cache.invalidateQueries({ queryKey: ['machines'] })
                void cache.invalidateQueries({ queryKey: ['sessions'] })
              }}
            />
          ))}
        </>
      ) : (
        state.data && (
          <>
            <p className="text-sm">
              Choose a folder to start syncing. Existing shared history connects automatically;
              unmatched projects can be mapped to folders on this computer.
            </p>
            <Button variant="outline" disabled={busy} onClick={() => void run(chooseFolder)}>
              {busy ? 'Connecting...' : 'Choose shared folder'}
            </Button>
            {folder && <p className="break-all text-sm">{folder}</p>}
            {emptyFolder && (
              <>
                <p className="text-sm">
                  No shared history has arrived yet. This folder is checked automatically. If this
                  is your first computer, start a new history here.
                </p>
                <Button disabled={busy} onClick={() => void run(() => checkFolder(folder, true))}>
                  Start new history here
                </Button>
              </>
            )}
            {choices.length > 1 && (
              <>
                <label className="block text-sm">
                  Shared history{' '}
                  <select
                    aria-label="Shared history"
                    value={selected}
                    onChange={(event) => setSelected(event.target.value)}
                  >
                    <option value="">Choose a history</option>
                    {choices.map((choice) => (
                      <option key={choice.workspaceId} value={choice.workspaceId}>
                        {choice.name} ({choice.workspaceId.slice(0, 8)})
                      </option>
                    ))}
                  </select>
                </label>
                <Button
                  disabled={busy || !selected}
                  onClick={() =>
                    void run(async () => {
                      const result = await window.api.folderSync.connect({
                        mode: 'join',
                        folder,
                        workspaceId: selected
                      })
                      if (!result.success) throw new Error(result.error.message)
                      received(result.data)
                    })
                  }
                >
                  Connect
                </Button>
              </>
            )}
            <p className="text-sm text-[var(--text-muted)]">
              Shares activity, clients, projects and invoices. API keys and full transcripts stay on
              this computer.
            </p>
          </>
        )
      )}
    </section>
  )
}
