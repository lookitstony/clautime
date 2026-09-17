import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import type { SessionReconciliationCase } from '../../../../shared/types/session'

export function ActivityMappingForm({
  review,
  presentationMode,
  onClose
}: {
  review: SessionReconciliationCase
  presentationMode: boolean
  onClose: () => void
}): React.JSX.Element {
  const [selected, setSelected] = useState<string[]>(() => review.detected.map(() => ''))
  const active = review.saved.filter((row) => row.disposition === 'active')
  const queryClient = useQueryClient()
  const valid =
    !!review.fingerprint &&
    review.detected.length > 0 &&
    active.length === review.detected.length &&
    review.saved.every((row) => row.disposition === 'active' || row.disposition === 'replaced') &&
    selected.every(Boolean) &&
    new Set(selected).size === active.length
  const mapping = useMutation({
    mutationFn: async () => {
      const result = await window.api.sessions.mapSavedHistory(
        review.sourceFile,
        review.fingerprint!,
        selected.map((id, detectedIndex) => ({ sessionId: Number(id), detectedIndex }))
      )
      if (!result.success) throw new Error(result.error.message)
    },
    onSuccess: () => {
      toast.success('Activity mapped to saved sessions')
      onClose()
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ['sessions'] })
      queryClient.invalidateQueries({ queryKey: ['live'] })
      queryClient.invalidateQueries({ queryKey: ['git', 'commits', 'session'] })
      queryClient.invalidateQueries({ queryKey: ['ai', 'summary'] })
    }
  })
  return (
    <form
      className="mt-2 space-y-2 rounded border border-[var(--surface-border)] p-3"
      onSubmit={(event) => {
        event.preventDefault()
        if (valid && !mapping.isPending) mapping.mutate()
      }}
    >
      <p>
        Choose the saved session for each detected interval shown above. Each saved session must be
        used once.
      </p>
      <p>
        Saved times, assignments, descriptions and billable choices stay. Prompt and token totals,
        including cache usage, will change to the detected values. Earlier values remain in audit
        history; saved invoices stay unchanged.
      </p>
      <p>Later scans will update the mapped activity. Existing time edits remain fixed.</p>
      {active.some((row) => row.sourceFile === null || row.sourceFile === '') && (
        <p>Saved sessions without a source log will be linked to this log when you confirm.</p>
      )}
      {review.detected.map((interval, index) => (
        <label key={index} className="block">
          Detected interval {index + 1}: {new Date(interval.startedAt).toLocaleString()} –{' '}
          {new Date(interval.endedAt).toLocaleString()}
          <select
            aria-label={`Saved session for detected interval ${index + 1}`}
            className="ml-2 rounded border border-[var(--surface-border)] bg-[var(--background-primary)] p-1"
            value={selected[index]}
            disabled={mapping.isPending}
            onChange={(event) =>
              setSelected((values) =>
                values.map((value, i) => (i === index ? event.target.value : value))
              )
            }
          >
            <option value="">Choose saved session</option>
            {active.map((saved) => (
              <option key={saved.id} value={saved.id}>
                Session #{saved.id}: {new Date(saved.startedAt).toLocaleString()} –{' '}
                {new Date(saved.endedAt).toLocaleString()}
              </option>
            ))}
          </select>
        </label>
      ))}
      {mapping.error && (
        <p role="alert">
          {presentationMode
            ? 'Could not apply the mapping. Recheck retained activity and try again.'
            : mapping.error.message}
        </p>
      )}
      <Button type="submit" size="xs" disabled={!valid || mapping.isPending}>
        Confirm activity mapping
      </Button>
      <Button
        type="button"
        size="xs"
        variant="ghost"
        className="ml-2"
        disabled={mapping.isPending}
        onClick={onClose}
      >
        Cancel
      </Button>
    </form>
  )
}
