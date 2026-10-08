import { useQuery } from '@tanstack/react-query'
import { usePresentationMode } from '../settings/use-presentation-mode'

export function SharedInvoiceCoverage(): React.JSX.Element | null {
  const presentation = usePresentationMode()
  const connection = useQuery({
    queryKey: ['folder-sync'],
    queryFn: async () => {
      const result = await window.api.folderSync.status()
      if (!result.success) throw new Error(result.error.message)
      return result.data
    },
    refetchInterval: 15_000
  })
  const coverage = useQuery({
    queryKey: ['machines', 'coverage'],
    queryFn: async () => {
      const result = await window.api.machines.coverage()
      if (!result.success) throw new Error(result.error.message)
      return result.data
    },
    enabled: !!connection.data?.connected,
    refetchInterval: 15_000
  })
  if (connection.error)
    return <p role="alert">Shared history status is unavailable: {connection.error.message}</p>
  if (!connection.data?.connected) return null
  const format = (value: string | null) => (value ? new Date(value).toLocaleString() : 'Unknown')
  return (
    <section
      className="space-y-2 rounded-lg border border-[var(--surface-border)] p-4 text-sm"
      aria-label="Shared billing coverage"
    >
      <p>
        Invoices include all computers in the chosen client, project, and dates. The Sessions
        computer filter does not limit billing.
      </p>
      <p className="text-[var(--text-muted)]">
        These are the latest records available here. An offline computer may have newer work; a
        folder check does not confirm cloud delivery.
      </p>
      {!connection.data.enabled && <p>Folder transfers are paused.</p>}
      {connection.data.issues.map((issue, index) => (
        <p key={index} role="status">
          {issue.message}
        </p>
      ))}
      {coverage.error && (
        <p role="alert">Unable to load computer coverage: {coverage.error.message}</p>
      )}
      <ul className="space-y-1">
        {coverage.data?.map((machine, index) => (
          <li key={machine.deviceId}>
            <strong>
              {presentation ? `Computer ${index + 1}` : machine.label}
              {machine.isThisComputer ? ' (this computer)' : ''}
            </strong>
            : latest activity {format(machine.latestActivityAt)}; last received here{' '}
            {format(machine.lastReceivedAt)}
          </li>
        ))}
      </ul>
    </section>
  )
}
