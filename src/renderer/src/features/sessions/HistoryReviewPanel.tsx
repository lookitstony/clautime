import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { formatDuration } from '@/lib/format'
import { usePresentationMode } from '../settings/use-presentation-mode'
import { ActivityMappingForm } from './ActivityMappingForm'
import { HistoryReplacementForm } from './HistoryReplacementForm'
import type { ReconciliationPreview } from '../../../../shared/types/session'

function Comparison({
  title,
  rows
}: {
  title: string
  rows: ReconciliationPreview[]
}): React.JSX.Element {
  return (
    <div className="min-w-0">
      <h4 className="font-medium">{title}</h4>
      {rows.length === 0 ? (
        <p>No intervals.</p>
      ) : (
        <ul className="space-y-2">
          {rows.map((row, index) => (
            <li key={row.id ?? index} className="rounded border border-[var(--surface-border)] p-2">
              <p>
                {row.id != null ? `Session #${row.id} · ` : ''}
                {row.disposition === 'split'
                  ? 'Split predecessor (audit only)'
                  : row.disposition === 'replaced'
                    ? 'Replaced predecessor (audit only)'
                    : row.disposition === 'deleted'
                      ? 'Deleted (audit only)'
                      : row.disposition === 'active'
                        ? 'Active history'
                        : `Detected interval ${index + 1}`}
              </p>
              {row.disposition === 'active' &&
                (row.sourceFile === null || row.sourceFile === '') && <p>Source log not linked</p>}
              <p>
                {new Date(row.startedAt).toLocaleString()} –{' '}
                {new Date(row.endedAt).toLocaleString()}
              </p>
              <p>
                {formatDuration(row.durationMinutes)} · {row.promptCount} prompts ·{' '}
                {row.inputTokens} input / {row.outputTokens} output tokens
              </p>
              {row.modelUsage.map((usage) => (
                <p key={usage.model} className="text-[var(--text-muted)]">
                  {usage.model}: {usage.inputTokens} input / {usage.outputTokens} output /{' '}
                  {usage.cacheCreationInputTokens} cache write / {usage.cacheReadInputTokens} cache
                  read
                </p>
              ))}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

export function HistoryReviewPanel(): React.JSX.Element | null {
  const queryClient = useQueryClient()
  const presentationMode = usePresentationMode()
  const [mappingSource, setMappingSource] = useState<string | null>(null)
  const [replacement, setReplacement] = useState<{
    sourceFile: string
    fingerprint: string
  } | null>(null)
  const [confirmation, setConfirmation] = useState<{
    sourceFile: string
    fingerprint: string
  } | null>(null)
  const reviews = useQuery({
    queryKey: ['sessions', 'reconciliation'],
    queryFn: async () => {
      const result = await window.api.sessions.getReconciliationCases()
      if (!result.success) throw new Error(result.error.message)
      return result.data
    }
  })
  const recheck = useMutation({
    mutationFn: async (sourceFile: string) => {
      const result = await window.api.sessions.recheckReconciliation(sourceFile)
      if (!result.success) throw new Error(result.error.message)
      return result.data
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ['sessions'] })
      queryClient.invalidateQueries({ queryKey: ['live'] })
    }
  })
  const keep = useMutation({
    mutationFn: async ({
      sourceFile,
      fingerprint
    }: {
      sourceFile: string
      fingerprint: string
    }) => {
      const result = await window.api.sessions.keepSavedHistory(sourceFile, fingerprint)
      if (!result.success) throw new Error(result.error.message)
    },
    onSuccess: () => {
      setConfirmation(null)
      toast.success('Saved history kept for this comparison')
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ['sessions'] })
      queryClient.invalidateQueries({ queryKey: ['live'] })
    }
  })
  const mappingOpen =
    reviews.data?.some(
      (review) =>
        review.sourceFile === mappingSource || review.sourceFile === replacement?.sourceFile
    ) ?? false
  if (reviews.error)
    return (
      <div role="alert" className="shrink-0 p-4 text-sm">
        Could not load history reviews. {presentationMode ? '' : reviews.error.message}
        <Button size="xs" variant="ghost" onClick={() => reviews.refetch()}>
          Retry
        </Button>
      </div>
    )
  if (!reviews.data?.length) return null
  return (
    <section
      aria-label="History reviews"
      className="max-h-[45vh] shrink-0 overflow-auto border-b border-[var(--surface-border)] p-4 text-xs"
    >
      <h3 className="font-medium">{reviews.data.length} source file(s) need history review</h3>
      <p className="my-2 text-[var(--text-secondary)]">
        Active saved history remains in totals. Detected alternatives are held outside totals.
        Invoice items for affected work are blocked until the review is resolved.
      </p>
      <p className="mb-2 text-[var(--text-secondary)]">
        Recheck uses retained activity and the current idle timeout. If a timeout change caused the
        mismatch, restore the previous setting and recheck. One-to-one activity mappings are
        available when active saved and detected counts match. Detected split/merge intervals can be
        accepted when their saved times are unedited; one-to-one matches preserve time edits.
        Conflicting assignments or descriptions require a choice of saved values. Explicit splits or
        deletions still need a separate resolution.
      </p>
      {recheck.error && (
        <p role="alert">
          {presentationMode ? 'Recheck failed. Try again.' : recheck.error.message}
        </p>
      )}
      {keep.error && (
        <p role="alert">
          {presentationMode
            ? 'Could not keep this comparison. Recheck and try again.'
            : keep.error.message}
        </p>
      )}
      {recheck.data?.errors?.length ? (
        <p role="status">Recheck still needs review. Saved history was retained.</p>
      ) : null}
      {reviews.data.map((review, index) => (
        <details key={review.sourceFile} className="border-t border-[var(--surface-border)] py-2">
          <summary className="cursor-pointer break-all">
            {presentationMode ? `Source ${index + 1}` : review.sourceFile}
          </summary>
          <p className="my-2 break-words">
            {presentationMode
              ? 'Saved history could not be matched to retained activity.'
              : review.message}
          </p>
          <p className="mb-2 text-[var(--text-muted)]">
            Last compared {new Date(review.updatedAt).toLocaleString()} with a{' '}
            {review.idleTimeoutMinutes}-minute idle timeout. Values below are from that comparison.
            Detected intervals are shown before applying saved splits or deletions.
          </p>
          <div className="grid gap-3 md:grid-cols-2">
            <Comparison title="Saved history at last check" rows={review.saved} />
            <Comparison title="Detected from retained activity" rows={review.detected} />
          </div>
          <Button
            className="mt-2"
            size="xs"
            variant="ghost"
            disabled={recheck.isPending || keep.isPending || mappingOpen}
            onClick={() => recheck.mutate(review.sourceFile)}
          >
            {recheck.isPending && recheck.variables === review.sourceFile
              ? 'Rechecking…'
              : 'Recheck retained activity'}
          </Button>
          <Button
            className="ml-2 mt-2"
            size="xs"
            variant="ghost"
            disabled={!review.fingerprint || recheck.isPending || keep.isPending || mappingOpen}
            onClick={() => {
              keep.reset()
              setConfirmation({ sourceFile: review.sourceFile, fingerprint: review.fingerprint! })
            }}
          >
            Keep saved history
          </Button>
          {review.saved.some((row) => row.disposition === 'active') &&
            review.saved.filter((row) => row.disposition === 'active').length ===
              review.detected.length &&
            review.saved.every(
              (row) =>
                (row.disposition === 'active' || row.disposition === 'replaced') && row.id != null
            ) && (
              <Button
                className="ml-2 mt-2"
                size="xs"
                variant="ghost"
                disabled={!review.fingerprint || recheck.isPending || keep.isPending || mappingOpen}
                onClick={() => {
                  setConfirmation(null)
                  setMappingSource(review.sourceFile)
                }}
              >
                Map detected activity
              </Button>
            )}
          {review.saved.some((row) => row.disposition === 'active') &&
            review.detected.length > 0 &&
            review.saved.every(
              (row) => row.disposition === 'active' || row.disposition === 'replaced'
            ) && (
              <Button
                className="ml-2 mt-2"
                size="xs"
                variant="ghost"
                disabled={!review.fingerprint || recheck.isPending || keep.isPending || mappingOpen}
                onClick={() => {
                  setConfirmation(null)
                  setReplacement({
                    sourceFile: review.sourceFile,
                    fingerprint: review.fingerprint!
                  })
                }}
              >
                Use detected intervals
              </Button>
            )}
          {replacement?.sourceFile === review.sourceFile && (
            <HistoryReplacementForm
              review={review}
              fingerprint={replacement.fingerprint}
              presentationMode={presentationMode}
              onClose={() => setReplacement(null)}
            />
          )}
          {mappingSource === review.sourceFile && (
            <ActivityMappingForm
              key={`${review.sourceFile}:${review.fingerprint}`}
              review={review}
              presentationMode={presentationMode}
              onClose={() => setMappingSource(null)}
            />
          )}
          {!review.fingerprint && (
            <p>Recheck this older comparison before choosing a resolution.</p>
          )}
          {confirmation?.sourceFile === review.sourceFile && (
            <div className="mt-2 space-y-2 rounded border border-[var(--surface-border)] p-3">
              <p>
                Keep the saved values shown above, including existing splits and deletions. Detected
                alternatives will stay outside totals, and invoice previews can use the saved
                history.
              </p>
              <p>
                This decision covers this comparison only. New activity, saved edits or policy
                changes will require another review.
              </p>
              {confirmation.fingerprint !== review.fingerprint && (
                <p role="alert">
                  The comparison changed. Review the updated values and choose Keep saved history
                  again.
                </p>
              )}
              <Button
                size="xs"
                disabled={
                  keep.isPending ||
                  recheck.isPending ||
                  confirmation.fingerprint !== review.fingerprint
                }
                onClick={() => keep.mutate(confirmation)}
              >
                Confirm keep saved history
              </Button>
              <Button
                className="ml-2"
                size="xs"
                variant="ghost"
                disabled={keep.isPending}
                onClick={() => setConfirmation(null)}
              >
                Cancel
              </Button>
            </div>
          )}
        </details>
      ))}
    </section>
  )
}
