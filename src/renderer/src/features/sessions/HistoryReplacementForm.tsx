import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import type { SessionReconciliationCase } from '../../../../shared/types/session'

export function HistoryReplacementForm({
  review,
  fingerprint,
  presentationMode,
  onClose
}: {
  review: SessionReconciliationCase
  fingerprint: string
  presentationMode: boolean
  onClose: () => void
}): React.JSX.Element {
  const client = useQueryClient()
  const [selected, setSelected] = useState<Record<number, string>>({})
  const stale = fingerprint !== review.fingerprint
  const complete = review.detected.every(
    (interval, index) =>
      !interval.requiresReplacementChoice ||
      interval.replacementCandidates?.includes(Number(selected[index]))
  )
  const replacement = useMutation({
    mutationFn: async () => {
      const choices = review.detected.flatMap((interval, detectedIndex) =>
        interval.requiresReplacementChoice && selected[detectedIndex]
          ? [{ detectedIndex, sessionId: Number(selected[detectedIndex]) }]
          : []
      )
      const result = await window.api.sessions.replaceSavedHistory(
        review.sourceFile,
        fingerprint,
        choices
      )
      if (!result.success) throw new Error(result.error.message)
    },
    onSuccess: () => {
      toast.success('Detected intervals accepted')
      onClose()
    },
    onSettled: () => {
      client.invalidateQueries({ queryKey: ['sessions'] })
      client.invalidateQueries({ queryKey: ['live'] })
      client.invalidateQueries({ queryKey: ['git', 'commits', 'session'] })
      client.invalidateQueries({ queryKey: ['ai', 'summary'] })
    }
  })
  return (
    <div className="mt-2 space-y-2 rounded border border-[var(--surface-border)] p-3">
      <p>
        Use the detected intervals, prompts and token totals shown above. Saved time edits are
        preserved for unambiguous one-to-one matches; unedited time fields follow the detected
        values. Replaced sessions remain in audit history; saved invoices and billed-work exclusions
        are preserved.
      </p>
      <p>
        Assignments, descriptions and billable choices carry forward when they agree. For
        conflicting values, choose the saved values to use for each interval below. All other saved
        values remain in audit history. Splitting or merging edited times, older history that cannot
        be matched to retained activity, and explicit splits or deletions need a separate
        resolution.
      </p>
      {review.detected.map(
        (interval, index) =>
          interval.requiresReplacementChoice && (
            <div key={index} className="space-y-2">
              <label className="block">
                Values for detected interval {index + 1}
                <select
                  aria-label={`Values for detected interval ${index + 1}`}
                  className="ml-2 rounded border border-[var(--surface-border)] bg-[var(--background-primary)] p-1"
                  value={selected[index] ?? ''}
                  disabled={stale || replacement.isPending}
                  onChange={(event) =>
                    setSelected((values) => ({ ...values, [index]: event.target.value }))
                  }
                >
                  <option value="">Choose saved values</option>
                  {review.saved
                    .filter(
                      (saved) =>
                        saved.disposition === 'active' &&
                        interval.replacementCandidates?.includes(saved.id!)
                    )
                    .map((saved) => (
                      <option key={saved.id} value={saved.id}>
                        Session #{saved.id}
                      </option>
                    ))}
                </select>
              </label>
              <p>
                The selected session supplies the project, client, description, billable choice and
                status.
              </p>
              <ul className="space-y-1">
                {review.saved
                  .filter(
                    (saved) =>
                      saved.disposition === 'active' &&
                      interval.replacementCandidates?.includes(saved.id!)
                  )
                  .map((saved) => (
                    <li key={saved.id}>
                      Session #{saved.id}: {saved.billable ? 'Billable' : 'Non-billable'} ·{' '}
                      {saved.status}
                      {!presentationMode && (
                        <span>
                          {' '}
                          · Project {saved.projectId == null
                            ? 'unassigned'
                            : `#${saved.projectId}`}{' '}
                          ({saved.projectPath}) · Client{' '}
                          {saved.clientId == null ? 'unassigned' : `#${saved.clientId}`} ·{' '}
                          {saved.description || 'No description'}
                        </span>
                      )}
                    </li>
                  ))}
              </ul>
            </div>
          )
      )}
      {stale && (
        <p role="alert">
          The comparison changed. Cancel and review the updated intervals before confirming.
        </p>
      )}
      {replacement.error && (
        <p role="alert">
          {presentationMode
            ? 'Could not replace history. Recheck retained activity and review the saved edits.'
            : replacement.error.message}
        </p>
      )}
      <Button
        size="xs"
        disabled={stale || !complete || replacement.isPending}
        onClick={() => replacement.mutate()}
      >
        Confirm detected intervals
      </Button>
      <Button
        className="ml-2"
        size="xs"
        variant="ghost"
        disabled={replacement.isPending}
        onClick={onClose}
      >
        Cancel
      </Button>
    </div>
  )
}
