import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Button } from '@/components/ui/button'

export function LocalFoldersSettings({
  noticeOnly = false,
  onConfigure
}: {
  noticeOnly?: boolean
  onConfigure?: () => void
} = {}): React.JSX.Element | null {
  const queryClient = useQueryClient()
  const [selected, setSelected] = useState<string[]>([])
  const setup = useQuery({
    queryKey: ['local-project-setup'],
    queryFn: async () => {
      const result = await window.api.projects.getLocalSetup()
      if (!result.success) throw new Error(result.error.message)
      return result.data
    }
  })
  const save = useMutation({
    mutationFn: async () => {
      const candidates = setup.data?.candidates ?? []
      const result = await window.api.projects.completeLocalSetup(
        candidates.filter((candidate) => selected.includes(candidate.projectSyncId))
      )
      if (!result.success) throw new Error(result.error.message)
      return result.data
    },
    onSuccess: (result) => {
      queryClient.setQueryData(['local-project-setup'], result)
      queryClient.invalidateQueries({ queryKey: ['projects'] })
      queryClient.invalidateQueries({ queryKey: ['sessions'] })
      queryClient.invalidateQueries({ queryKey: ['live'] })
    }
  })
  if (noticeOnly) {
    return setup.data && !setup.data.complete ? (
      <div
        role="status"
        className="flex items-center justify-between gap-3 border-b border-[var(--surface-border)] px-4 py-2 text-sm"
      >
        <span>
          Review which project folders belong to this computer. Saved history is available.
        </span>
        <Button variant="outline" onClick={onConfigure}>
          Review folders
        </Button>
      </div>
    ) : null
  }
  return (
    <section className="space-y-3 rounded-lg border border-[var(--surface-border)] bg-[var(--background-elevated)] p-4">
      <h2 className="text-[14px] font-semibold">Folders on this computer</h2>
      {setup.isPending && <p>Loading folder setup…</p>}
      {setup.error && <p role="alert">{setup.error.message}</p>}
      {setup.data && (
        <>
          <p className="text-sm text-[var(--text-muted)]">Computer: {setup.data.machineName}</p>
          {setup.data.complete ? (
            <p className="text-sm">
              Folder setup is complete. Change or disconnect a folder in the project&apos;s
              settings.
            </p>
          ) : (
            <>
              <p className="text-sm">
                Select the existing project folders that belong to this computer. Unselected
                projects keep their history without a local folder. New projects will be discovered
                automatically after setup.
              </p>
              {setup.data.candidates.map((candidate) => (
                <label key={candidate.projectSyncId} className="flex items-start gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={selected.includes(candidate.projectSyncId)}
                    disabled={save.isPending}
                    onChange={(event) =>
                      setSelected((current) =>
                        event.target.checked
                          ? [...current, candidate.projectSyncId]
                          : current.filter((id) => id !== candidate.projectSyncId)
                      )
                    }
                  />
                  <span>
                    {candidate.projectName}
                    <span className="block break-all text-xs text-[var(--text-muted)]">
                      {candidate.directoryPath}
                    </span>
                  </span>
                </label>
              ))}
              <Button disabled={save.isPending} onClick={() => save.mutate()}>
                {save.isPending ? 'Saving…' : 'Use selected folders on this computer'}
              </Button>
              {save.error && <p role="alert">{save.error.message}</p>}
            </>
          )}
        </>
      )}
    </section>
  )
}
