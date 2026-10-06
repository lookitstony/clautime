import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Button } from '@/components/ui/button'
import type {
  WorkspacePolicyState,
  WorkspacePolicyReview,
  WorkspaceActivityAdoptionReview,
  WorkspaceMetadataChoice
} from '../../../../shared/types/workspace-policy'

export function WorkspacePolicySettings({
  workspace
}: {
  workspace: WorkspacePolicyState
}): React.JSX.Element {
  const queryClient = useQueryClient()
  const [timeout, setTimeoutValue] = useState(workspace.policy.idleTimeoutMinutes)
  const [zone, setZone] = useState(workspace.policy.reportingTimeZone)
  const [review, setReview] = useState<WorkspacePolicyReview | null>(null)
  const [adoption, setAdoption] = useState<WorkspaceActivityAdoptionReview | null>(null)
  const [selected, setSelected] = useState<string[]>([])
  const [held, setHeld] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const candidate = { ...workspace.policy, idleTimeoutMinutes: timeout, reportingTimeZone: zone }
  // Saved history outside every retained conversation; manual and audit rows need no link.
  const grouped = new Set(
    adoption?.conversations.flatMap((row) => row.sessions.map((item) => item.sessionId)) ?? []
  )
  const unlinkable =
    adoption?.rows.filter(
      (row) =>
        !grouped.has(row.sessionId) &&
        row.reason !== null &&
        row.reason !== 'manual-entry' &&
        row.reason !== 'audit-history'
    ) ?? []
  const run = async (action: () => Promise<void>): Promise<void> => {
    setBusy(true)
    setError('')
    setMessage('')
    try {
      await action()
    } catch (error) {
      setError(error instanceof Error ? error.message : 'The review could not be completed')
    } finally {
      setBusy(false)
    }
  }
  const preview = async (
    choices: WorkspaceMetadataChoice[] = [],
    acknowledgedReductions: string[] = []
  ): Promise<void> => {
    const result = await window.api.workspace.reviewPolicy({
      candidate,
      decisionId: review?.decisionId,
      choices,
      acknowledgedReductions
    })
    if (!result.success) {
      setReview(null)
      setHeld([])
      throw new Error(result.error.message)
    }
    setReview(result.data)
    setHeld([])
  }
  const refresh = (): void => {
    for (const key of ['workspace-policy', 'settings', 'sessions', 'live', 'reports', 'invoices'])
      queryClient.invalidateQueries({ queryKey: [key] })
  }
  const changeInputs = (): void => {
    setReview(null)
    setHeld([])
    setMessage('')
  }

  return (
    <div className="mb-4 space-y-3 text-[12px]">
      <h3 className="font-semibold">Shared tracking policy</h3>
      <p className="text-[var(--text-muted)]">
        All connected computers use this timeout and reporting timezone. Review changes before
        recalculating saved history. Issued invoices retain their saved amounts.
      </p>
      <label className="block">
        Human Time Allowance (minutes)
        <input
          aria-label="Shared human time allowance"
          type="number"
          min="1"
          value={timeout}
          disabled={busy}
          onChange={(event) => {
            setTimeoutValue(Number(event.target.value))
            changeInputs()
          }}
          className="ml-2 w-20 rounded border bg-transparent p-1"
        />
      </label>
      <label className="block">
        Reporting timezone
        <input
          aria-label="Reporting timezone"
          value={zone}
          disabled={busy}
          onChange={(event) => {
            setZone(event.target.value)
            changeInputs()
          }}
          className="ml-2 rounded border bg-transparent p-1"
        />
      </label>
      <div className="flex gap-2">
        <Button
          size="sm"
          disabled={busy || !Number.isFinite(timeout) || timeout <= 0 || !zone.trim()}
          onClick={() => run(() => preview())}
        >
          Review policy change
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() =>
            run(async () => {
              const result = await window.api.workspace.reviewActivity()
              if (!result.success) throw new Error(result.error.message)
              setAdoption(result.data)
              setSelected([])
              setReview(null)
            })
          }
        >
          Review captured activity
        </Button>
      </div>
      {adoption && (
        <div className="space-y-2 rounded border p-3">
          <p>
            Link matched saved sessions to their retained activity before recalculating them. Saved
            descriptions, edits and invoices stay intact.
          </p>
          <p>Each conversation is linked as a whole, including every saved session in it.</p>
          {adoption.conversations.map((row) => (
            <div key={row.key} className="space-y-1 border-b pb-2">
              <label className="block">
                <input
                  type="checkbox"
                  disabled={busy || row.status !== 'ready'}
                  checked={row.status === 'linked' || selected.includes(row.key)}
                  onChange={(event) =>
                    setSelected((keys) =>
                      event.target.checked
                        ? [...keys, row.key]
                        : keys.filter((key) => key !== row.key)
                    )
                  }
                />{' '}
                {row.provider} · {row.conversationId} · {row.sessions.length} saved sessions ·{' '}
                {row.sessions.reduce((sum, item) => sum + item.durationMinutes, 0)} min ·{' '}
                {row.status === 'linked'
                  ? 'Linked'
                  : row.status === 'ready'
                    ? 'Ready to link'
                    : `Blocked: ${row.reasons.map((reason) => reason.replaceAll('-', ' ')).join(', ')}`}
              </label>
              <ul className="ml-5 text-[var(--text-muted)]">
                {row.sessions.map((item) => (
                  <li key={item.sessionId}>
                    {item.startedAt} · {item.durationMinutes} min
                    {item.adopted ? ' · Linked' : ''}
                  </li>
                ))}
              </ul>
            </div>
          ))}
          {!adoption.conversations.length && <p>No saved conversations to link.</p>}
          {unlinkable.map((row) => (
            <p key={row.sessionId} className="text-[var(--text-muted)]">
              Saved session {row.sessionId} · {row.startedAt} · Cannot link:{' '}
              {row.reason?.replaceAll('-', ' ')}
            </p>
          ))}
          <Button
            size="sm"
            disabled={busy || !selected.length}
            onClick={() =>
              run(async () => {
                const result = await window.api.workspace.adoptActivity(
                  adoption.fingerprint,
                  adoption.conversations
                    .filter((row) => row.status === 'ready' && selected.includes(row.key))
                    .flatMap((row) => row.pendingSessionIds)
                )
                if (!result.success) {
                  setAdoption(null)
                  throw new Error(result.error.message)
                }
                setAdoption(null)
                setSelected([])
                refresh()
                await preview()
              })
            }
          >
            Link selected conversations
          </Button>
        </div>
      )}
      {review && (
        <div className="space-y-3 rounded border p-3" aria-label="Policy change review">
          {review.conversations.map((row) => (
            <div key={row.key} className="space-y-1 border-b pb-2">
              <p className="font-semibold">
                {row.provider} · {row.conversationId}
              </p>
              <p>
                {row.before.length} saved sessions ·{' '}
                {row.before.reduce((sum, item) => sum + item.durationMinutes, 0)} min
                {row.status === 'applicable' && (
                  <>
                    {' '}
                    → {row.after.length} sessions ·{' '}
                    {row.after.reduce((sum, item) => sum + item.durationMinutes, 0)} min
                  </>
                )}
              </p>
              {row.requiredChoices.map((choice) => (
                <label key={choice.afterIndex} className="block">
                  Choose details to carry forward ({choice.fields.join(', ')})
                  <select
                    aria-label={`Details for ${row.conversationId} interval ${choice.afterIndex + 1}`}
                    disabled={busy}
                    value=""
                    onChange={(event) =>
                      run(() =>
                        preview(
                          [
                            ...review.choices.filter(
                              (item) =>
                                item.provider !== row.provider ||
                                item.conversationId !== row.conversationId ||
                                item.afterIndex !== choice.afterIndex
                            ),
                            {
                              provider: row.provider,
                              conversationId: row.conversationId,
                              afterIndex: choice.afterIndex,
                              sourceSessionId: Number(event.target.value)
                            }
                          ],
                          review.acknowledgedReductions
                        )
                      )
                    }
                    className="block w-full rounded border bg-[var(--background-primary)] p-1"
                  >
                    <option value="" disabled>
                      Select a saved session
                    </option>
                    {choice.sources.map((source) => (
                      <option key={source.sessionId} value={source.sessionId}>
                        {source.label}
                      </option>
                    ))}
                  </select>
                </label>
              ))}
              {row.status === 'held' && (
                <label className="block">
                  <input
                    type="checkbox"
                    disabled={busy}
                    checked={held.includes(row.key)}
                    onChange={(event) =>
                      setHeld((keys) =>
                        event.target.checked
                          ? [...keys, row.key]
                          : keys.filter((key) => key !== row.key)
                      )
                    }
                  />{' '}
                  Keep this saved history unchanged:{' '}
                  {row.reasons.map((reason) => reason.replaceAll('-', ' ')).join(', ')}
                </label>
              )}
            </div>
          ))}
          {review.reductions.map((reduction) => (
            <div key={reduction.key} className="rounded border border-amber-500/50 p-2">
              <label className="block">
                <input
                  type="checkbox"
                  disabled={busy}
                  checked={review.acknowledgedReductions.includes(reduction.key)}
                  onChange={(event) =>
                    run(() =>
                      preview(
                        review.choices,
                        event.target.checked
                          ? [...review.acknowledgedReductions, reduction.key]
                          : review.acknowledgedReductions.filter((key) => key !== reduction.key)
                      )
                    )
                  }
                />{' '}
                Recalculate {reduction.conversationId}: {reduction.beforeMinutes} →{' '}
                {reduction.afterMinutes} measured minutes; {reduction.uncountedEvents} events no
                longer counted. {reduction.uncountedTokens} tokens from {reduction.uncountedUsage}{' '}
                usage checkpoints no longer counted. Retained activity remains available.
              </label>
              <ul>
                {reduction.gaps.map((gap, index) => (
                  <li key={index}>
                    {gap.startedAt} – {gap.endedAt}
                  </li>
                ))}
              </ul>
            </div>
          ))}
          {review.retainedWithoutActivity.map((id) => (
            <label key={id} className="block">
              <input
                type="checkbox"
                disabled={busy}
                checked={held.includes(`saved:${id}`)}
                onChange={(event) =>
                  setHeld((keys) =>
                    event.target.checked
                      ? [...keys, `saved:${id}`]
                      : keys.filter((key) => key !== `saved:${id}`)
                  )
                }
              />{' '}
              Keep saved session {id} unchanged; retained activity is unavailable.
            </label>
          ))}
          <Button
            size="sm"
            disabled={busy || review.heldKeys.some((key) => !held.includes(key))}
            onClick={() =>
              run(async () => {
                const result = await window.api.workspace.applyPolicy({
                  decisionId: review.decisionId,
                  candidate: review.candidate,
                  expectedFingerprint: review.fingerprint,
                  choices: review.choices,
                  acknowledgedHeld: held,
                  acknowledgedReductions: review.acknowledgedReductions
                })
                if (!result.success) {
                  setReview(null)
                  setHeld([])
                  throw new Error(result.error.message)
                }
                setReview(null)
                setHeld([])
                setMessage('Tracking policy applied. Held history remains unchanged.')
                refresh()
              })
            }
          >
            Apply reviewed policy
          </Button>
        </div>
      )}
      {busy && <p role="status">Updating review…</p>}
      {message && <p role="status">{message}</p>}
      {error && (
        <p role="alert" className="text-red-400">
          {error}
        </p>
      )}
    </div>
  )
}
