import { useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { formatTimeRange } from '@/lib/format'
import { useSplitSession } from './use-sessions'
import type { Session } from '../../../../shared/types/session'

export function SplitSessionForm({
  session,
  onCancel,
  onComplete
}: {
  session: Session
  onCancel: () => void
  onComplete: () => void
}): React.JSX.Element {
  const start = Date.parse(session.startedAt)
  const end = Date.parse(session.endedAt)
  const [minutes, setMinutes] = useState(String((end - start) / 120_000))
  const [error, setError] = useState<string | null>(null)
  const mutation = useSplitSession()
  const cut = start + Number(minutes) * 60_000
  const valid = minutes.trim() !== '' && Number.isFinite(cut) && cut > start && cut < end
  return (
    <form
      className="space-y-2"
      onSubmit={(event) => {
        event.preventDefault()
        if (!valid) {
          setError('Choose a point inside the session.')
          return
        }
        setError(null)
        mutation.mutate(
          {
            id: session.id,
            splitAt: new Date(cut).toISOString(),
            expectedSyncVersion: session.syncVersion
          },
          {
            onSuccess: () => {
              toast.success('Session split')
              onComplete()
            },
            onError: (err) => setError(err.message)
          }
        )
      }}
    >
      <label className="block text-[12px] text-[var(--text-secondary)]">
        Split after (minutes)
        <input
          type="number"
          step="any"
          value={minutes}
          onChange={(event) => setMinutes(event.target.value)}
          disabled={mutation.isPending}
          className="ml-2 w-24 rounded border border-[var(--surface-border)] bg-[var(--background-primary)] px-2 py-1"
        />
      </label>
      {valid && (
        <p className="text-[12px] text-[var(--text-muted)]">
          {formatTimeRange(session.startedAt, new Date(cut).toISOString())} /{' '}
          {formatTimeRange(new Date(cut).toISOString(), session.endedAt)}
        </p>
      )}
      <p className="text-[12px] text-[var(--text-muted)]">
        Prompts and tokens are divided proportionally. Saved invoices are preserved.
      </p>
      {session.source === 'auto' && (
        <p className="text-[12px] text-[var(--text-muted)]">
          Older sessions use saved history. Returning activity may need review before it can update
          the split parts.
        </p>
      )}
      {error && (
        <p role="alert" className="text-[12px] text-red-400">
          {error}
        </p>
      )}
      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={mutation.isPending}>
          Confirm split
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={onCancel}
          disabled={mutation.isPending}
        >
          Cancel
        </Button>
      </div>
    </form>
  )
}
