import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Button } from '@/components/ui/button'
import { usePresentationMode } from './use-presentation-mode'
import type {
  ConflictField,
  JsonValue,
  LegacyConflict,
  LegacyEditConflict,
  LegacyLifecycleChoice,
  PolicyConflict,
  RecordConflict,
  SessionConflict,
  SessionConflictValues,
  SessionFragmentConflict,
  SyncConflictApi,
  SyncConflictItem,
  SyncConflictResolution
} from '../../../../shared/types/sync-conflict'

/** Registered by the preload as window.api.syncConflicts. */
function conflictApi(): SyncConflictApi {
  return (window.api as unknown as { syncConflicts: SyncConflictApi }).syncConflicts
}

const key = (value: JsonValue) => JSON.stringify(value)
const inputClass = 'rounded border border-[var(--surface-border)] bg-transparent px-2 py-1'

type Submit = (resolution: SyncConflictResolution) => Promise<void>

function Choices({
  name,
  field,
  value,
  onChange,
  extra,
  keepAgreed
}: {
  name: string
  field: ConflictField
  value: JsonValue | undefined
  onChange(value: JsonValue): void
  extra?: React.ReactNode
  /** Offer the last agreed value as a choice when it is not already one of the alternatives. */
  keepAgreed?: boolean
}) {
  const agreed = field.lastAgreed
  const offerAgreed =
    keepAgreed &&
    agreed &&
    !field.alternatives.some((choice) => key(choice.value) === key(agreed.value))
  return (
    <fieldset className="space-y-1 text-sm">
      <legend className="font-medium">{field.label}</legend>
      {agreed && !offerAgreed && (
        <p className="text-[var(--text-muted)]">Last agreed: {agreed.label}</p>
      )}
      {field.alternatives.map((choice) => (
        <label key={key(choice.value)} className="flex items-center gap-2">
          <input
            type="radio"
            name={name}
            checked={value !== undefined && key(value) === key(choice.value)}
            onChange={() => onChange(choice.value)}
          />
          {choice.label}
        </label>
      ))}
      {offerAgreed && (
        <label className="flex items-center gap-2">
          <input
            type="radio"
            name={name}
            checked={value !== undefined && key(value) === key(agreed.value)}
            onChange={() => onChange(agreed.value)}
          />
          Keep the last agreed value: {agreed.label}
        </label>
      )}
      {extra}
    </fieldset>
  )
}

function Actions({
  busy,
  ready,
  label,
  cancel
}: {
  busy: boolean
  ready: boolean
  label: string
  cancel(): void
}) {
  return (
    <div className="flex gap-2">
      <Button type="submit" disabled={busy || !ready}>
        {label}
      </Button>
      <Button type="button" variant="outline" disabled={busy} onClick={cancel}>
        Cancel
      </Button>
    </div>
  )
}

function RecordEditor({
  item,
  submit,
  cancel,
  busy
}: {
  item: RecordConflict
  submit: Submit
  cancel(): void
  busy: boolean
}) {
  const [present, setPresent] = useState<boolean | undefined>(
    item.lifecycleConflict ? undefined : true
  )
  // Manual entries choose keep or exactly one recorded removal (deleted or a split).
  const [lifecycle, setLifecycle] = useState<LegacyLifecycleChoice | undefined>()
  const [values, setValues] = useState<Record<string, JsonValue>>({})
  const ready =
    present === false ||
    (present === true &&
      item.fields.every((field) => field.field in values) &&
      (item.fields.length > 0 || item.lifecycleConflict))
  return (
    <form
      className="space-y-3"
      onSubmit={(event) => {
        event.preventDefault()
        void submit({
          kind: 'record',
          entityType: item.entityType,
          entityId: item.entityId,
          expectedHeads: item.expectedHeads,
          present: present!,
          values: present ? values : {},
          ...(lifecycle ? { disposition: lifecycle.disposition } : {})
        })
      }}
    >
      {item.lifecycleChoices && (
        <fieldset className="space-y-1 text-sm">
          <legend className="font-medium">
            It was kept, deleted or split differently on two computers
          </legend>
          {item.lifecycleChoices.map((choice) => (
            <label key={key(choice.disposition)} className="flex items-center gap-2">
              <input
                type="radio"
                name={`${item.key}:lifecycle`}
                checked={
                  lifecycle !== undefined && key(lifecycle.disposition) === key(choice.disposition)
                }
                onChange={() => {
                  setLifecycle(choice)
                  setPresent(choice.present)
                }}
              />
              {choice.label}
            </label>
          ))}
          {item.waiting?.map((line) => (
            <p key={line} className="text-[var(--text-muted)]">
              {line}
            </p>
          ))}
        </fieldset>
      )}
      {item.lifecycleConflict && !item.lifecycleChoices && (
        <fieldset className="space-y-1 text-sm">
          <legend className="font-medium">
            It was changed on one computer and deleted on another
          </legend>
          <label className="flex items-center gap-2">
            <input
              type="radio"
              name={`${item.key}:present`}
              checked={present === true}
              onChange={() => setPresent(true)}
            />{' '}
            Keep it
          </label>
          <label className="flex items-center gap-2">
            <input
              type="radio"
              name={`${item.key}:present`}
              checked={present === false}
              onChange={() => setPresent(false)}
            />
            {item.entityType === 'manual-entry'
              ? 'Delete it (kept for audit, no longer counted)'
              : 'Delete it (deactivated; its history stays)'}
          </label>
        </fieldset>
      )}
      {present !== false &&
        item.fields.map((field) => (
          <Choices
            key={field.field}
            name={`${item.key}:${field.field}`}
            field={field}
            value={values[field.field]}
            onChange={(value) => setValues((current) => ({ ...current, [field.field]: value }))}
          />
        ))}
      <Actions busy={busy} ready={ready} label="Save choice" cancel={cancel} />
    </form>
  )
}

function PolicyEditor({
  item,
  submit,
  cancel,
  busy
}: {
  item: PolicyConflict
  submit: Submit
  cancel(): void
  busy: boolean
}) {
  const [choice, setChoice] = useState<JsonValue | undefined>()
  return (
    <form
      className="space-y-3"
      onSubmit={(event) => {
        event.preventDefault()
        void submit({ kind: 'policy', expectedHeads: item.expectedHeads, policy: choice! })
      }}
    >
      <p className="text-sm">
        Computers chose different tracking policies. Pick one whole policy; its time zone and idle
        timeout stay together. Sessions that would change under it are held for review in Tracking
        settings.
      </p>
      {item.lastAgreed && (
        <p className="text-sm text-[var(--text-muted)]">Last agreed: {item.lastAgreed.label}</p>
      )}
      <fieldset className="space-y-1 text-sm">
        <legend className="font-medium">Tracking policy</legend>
        {item.alternatives.map((option) => (
          <label key={key(option.value)} className="flex items-center gap-2">
            <input
              type="radio"
              name={item.key}
              checked={choice !== undefined && key(choice) === key(option.value)}
              onChange={() => setChoice(option.value)}
            />
            {option.label}
          </label>
        ))}
      </fieldset>
      <Actions busy={busy} ready={choice !== undefined} label="Use this policy" cancel={cancel} />
    </form>
  )
}

function FragmentEditor({
  item,
  fragment,
  submit,
  cancel,
  busy
}: {
  item: SessionConflict
  fragment: SessionFragmentConflict
  submit: Submit
  cancel(): void
  busy: boolean
}) {
  const [values, setValues] = useState<Record<string, JsonValue>>({})
  const [description, setDescription] = useState<string | null>(null)
  const [time, setTime] = useState<{ startedAt: string; endedAt: string } | null>(null)
  const [accepted, setAccepted] = useState(false)
  const choose = (field: string) => (value: JsonValue) => {
    setValues((current) => ({ ...current, [field]: value }))
    if (field === 'description') setDescription(null)
    if (field === 'time') setTime(null)
  }
  const chosen = (field: string) =>
    field in values ||
    (field === 'description' && description !== null) ||
    (field === 'time' && time !== null)
  const ready =
    (fragment.fields.length ? fragment.fields : [{ field: 'billable' }]).every((field) =>
      chosen(field.field)
    ) &&
    (fragment.fields.length > 0 || accepted)
  function resolution(): SessionConflictValues {
    const result: SessionConflictValues = {}
    if ('assignment' in values)
      result.assignment = values.assignment as unknown as SessionConflictValues['assignment']
    if (description !== null) result.description = description.trim() ? description : null
    else if ('description' in values) result.description = values.description as string | null
    if ('billable' in values) result.billable = values.billable as boolean
    if (time !== null)
      result.time = {
        startedAt: new Date(time.startedAt).toISOString(),
        endedAt: new Date(time.endedAt).toISOString()
      }
    else if ('time' in values) result.time = values.time as SessionConflictValues['time']
    return result
  }
  // Accepting split changes records an edit, so the user states at least one value explicitly.
  const fields: ConflictField[] = fragment.fields.length
    ? fragment.fields
    : [
        {
          field: 'billable',
          label: 'Billable for this part',
          lastAgreed: null,
          alternatives: [
            { value: true, label: 'Yes' },
            { value: false, label: 'No' }
          ]
        }
      ]
  const base = {
    provider: item.provider,
    conversationId: item.conversationId,
    fragmentHash: fragment.fragmentHash,
    reviewFingerprint: item.reviewFingerprint
  }
  return (
    <form
      className="space-y-3"
      onSubmit={(event) => {
        event.preventDefault()
        void submit({
          kind: 'session-fragment',
          ...base,
          action: 'set',
          values: resolution(),
          acknowledgedCopyEdits: accepted
            ? fragment.copyEdits.map(({ entityId, source, revisions }) => ({
                entityId,
                source,
                revisions
              }))
            : []
        })
      }}
    >
      <p className="text-sm">
        Currently: {fragment.current.assignment}
        {fragment.current.description ? `, "${fragment.current.description}"` : ''},{' '}
        {fragment.current.billable ? 'billable' : 'not billable'}.
      </p>
      {fields.map((field) => (
        <Choices
          key={field.field}
          name={`${item.key}:${fragment.fragmentHash}:${field.field}`}
          field={field}
          value={values[field.field]}
          onChange={choose(field.field)}
          extra={
            field.field === 'description' ? (
              <label className="flex flex-col gap-1">
                Or enter a corrected description
                <textarea
                  aria-label="Corrected description"
                  className={inputClass}
                  value={description ?? ''}
                  maxLength={4000}
                  onChange={(event) => {
                    setDescription(event.target.value)
                    setValues(({ description: _drop, ...rest }) => rest)
                  }}
                />
              </label>
            ) : field.field === 'billable' ? (
              <>
                {[true, false]
                  .filter((option) => !field.alternatives.some((choice) => choice.value === option))
                  .map((option) => (
                    <label key={String(option)} className="flex items-center gap-2">
                      <input
                        type="radio"
                        name={`${item.key}:${fragment.fragmentHash}:billable`}
                        checked={values.billable === option}
                        onChange={() => choose('billable')(option)}
                      />{' '}
                      {option ? 'Yes' : 'No'}
                    </label>
                  ))}
              </>
            ) : field.field === 'time' ? (
              <div className="flex flex-wrap gap-2">
                <label className="flex items-center gap-2">
                  <input
                    type="radio"
                    name={`${item.key}:${fragment.fragmentHash}:time`}
                    checked={'time' in values && values.time === null}
                    onChange={() => choose('time')(null)}
                  />{' '}
                  Use the calculated time
                </label>
                <label>
                  Corrected start{' '}
                  <input
                    aria-label="Corrected start"
                    type="datetime-local"
                    className={inputClass}
                    value={time?.startedAt ?? ''}
                    onChange={(event) => {
                      setTime({ startedAt: event.target.value, endedAt: time?.endedAt ?? '' })
                      setValues(({ time: _drop, ...rest }) => rest)
                    }}
                  />
                </label>
                <label>
                  Corrected end{' '}
                  <input
                    aria-label="Corrected end"
                    type="datetime-local"
                    className={inputClass}
                    value={time?.endedAt ?? ''}
                    onChange={(event) => {
                      setTime({ startedAt: time?.startedAt ?? '', endedAt: event.target.value })
                      setValues(({ time: _drop, ...rest }) => rest)
                    }}
                  />
                </label>
              </div>
            ) : undefined
          }
        />
      ))}
      {fragment.copyEdits.length > 0 && (
        <label className="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            checked={accepted}
            onChange={(event) => setAccepted(event.target.checked)}
          />
          <span>
            {fragment.copyEdits.map((edit) => edit.summary).join(' ')} I reviewed these changes and
            my choices above replace them for this part.
          </span>
        </label>
      )}
      <Actions
        busy={busy}
        ready={ready && (time === null || (!!time.startedAt && !!time.endedAt))}
        label="Save choice"
        cancel={cancel}
      />
      {fragment.lifecycleConflict && (
        <Button
          type="button"
          variant="outline"
          disabled={busy}
          onClick={() =>
            void submit({
              kind: 'session-fragment',
              ...base,
              action: 'remove-edit',
              values: {},
              acknowledgedCopyEdits: []
            })
          }
        >
          Remove the edit and use the shared values
        </Button>
      )}
    </form>
  )
}

function SessionEditor({
  item,
  submit,
  cancel,
  busy
}: {
  item: SessionConflict
  submit: Submit
  cancel(): void
  busy: boolean
}) {
  const [mapping, setMapping] = useState<JsonValue | undefined>()
  const base = {
    provider: item.provider,
    conversationId: item.conversationId,
    reviewFingerprint: item.reviewFingerprint
  }
  return (
    <div className="space-y-4">
      {item.fragments.map((fragment) => (
        <div key={fragment.fragmentHash} className="space-y-2">
          <h4 className="text-sm font-medium">{fragment.title}</h4>
          <ul className="list-disc pl-5 text-sm">
            {fragment.reasons.map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
          </ul>
          <FragmentEditor
            item={item}
            fragment={fragment}
            submit={submit}
            cancel={cancel}
            busy={busy}
          />
        </div>
      ))}
      {item.mapping && (
        <form
          className="space-y-2"
          onSubmit={(event) => {
            event.preventDefault()
            void submit({
              kind: 'session-mapping',
              ...base,
              expectedHeads: item.mapping!.expectedHeads,
              value: mapping as never
            })
          }}
        >
          <Choices
            name={`${item.key}:mapping`}
            field={{
              field: 'assignment',
              label: 'Client and project for the whole conversation',
              lastAgreed: null,
              alternatives: item.mapping.alternatives
            }}
            value={mapping}
            onChange={setMapping}
          />
          <Actions busy={busy} ready={mapping !== undefined} label="Save choice" cancel={cancel} />
        </form>
      )}
      {item.deletions.map((deletion) => (
        <div key={`${deletion.operationId}:${deletion.entityId}`} className="space-y-2 text-sm">
          <p>{deletion.summary}</p>
          <Button
            type="button"
            disabled={busy}
            onClick={() =>
              void submit({
                kind: 'session-deletion',
                ...base,
                operationId: deletion.operationId,
                entityId: deletion.entityId
              })
            }
          >
            Keep the deletion
          </Button>
        </div>
      ))}
      {item.held.map((text) => (
        <p key={text} className="text-sm">
          {text}
        </p>
      ))}
    </div>
  )
}

function LegacyEditor({
  item,
  submit,
  cancel,
  busy
}: {
  item: LegacyConflict
  submit: Submit
  cancel(): void
  busy: boolean
}) {
  const [decisions, setDecisions] = useState<Record<string, 'keep' | 'duplicate'>>({})
  const pick = (decision: 'keep' | 'duplicate') =>
    item.candidates
      .filter((candidate) => decisions[candidate.legacyId] === decision)
      .map((candidate) => candidate.legacyId)
  const complete = item.candidates.every((candidate) => decisions[candidate.legacyId])
  const noneKept = complete && !pick('keep').length && !item.activityOverlap
  return (
    <form
      className="space-y-3"
      onSubmit={(event) => {
        event.preventDefault()
        void submit({
          kind: 'legacy',
          provider: item.provider,
          conversationId: item.conversationId,
          reviewFingerprint: item.reviewFingerprint,
          candidates: item.candidates.map((candidate) => candidate.legacyId),
          keep: pick('keep'),
          duplicates: pick('duplicate')
        })
      }}
    >
      <p className="text-sm">{item.explanation}</p>
      {item.previousReviews.length > 0 && (
        <div className="space-y-1 text-sm">
          <p className="font-medium">What each computer chose</p>
          {item.previousReviews.map((previous) => (
            <div key={previous.label} className="flex flex-wrap items-center gap-2">
              <span>{previous.label}</span>
              {/* Fills in the choices below only; nothing is saved until Save choice. */}
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() =>
                  setDecisions(
                    Object.fromEntries([
                      ...previous.keep.map((id) => [id, 'keep'] as const),
                      ...previous.duplicates.map((id) => [id, 'duplicate'] as const)
                    ])
                  )
                }
              >
                Start from this
              </Button>
            </div>
          ))}
        </div>
      )}
      {item.candidates.map((candidate, index) => (
        <fieldset key={candidate.legacyId} className="flex flex-wrap gap-3 text-sm">
          <legend>
            Saved copy {index + 1}: {candidate.label}{' '}
            {candidate.counting ? 'Counts now.' : 'Not counted now.'}
          </legend>
          <label>
            <input
              type="radio"
              name={`${item.key}:${candidate.legacyId}`}
              checked={decisions[candidate.legacyId] === 'keep'}
              onChange={() =>
                setDecisions((current) => ({ ...current, [candidate.legacyId]: 'keep' }))
              }
            />{' '}
            Keep counting
          </label>
          <label>
            <input
              type="radio"
              name={`${item.key}:${candidate.legacyId}`}
              checked={decisions[candidate.legacyId] === 'duplicate'}
              onChange={() =>
                setDecisions((current) => ({ ...current, [candidate.legacyId]: 'duplicate' }))
              }
            />{' '}
            Duplicate
          </label>
        </fieldset>
      ))}
      {noneKept && (
        <p className="text-sm">
          Keep at least one copy. No recorded activity covers this time, so marking every copy as a
          duplicate would drop it from totals.
        </p>
      )}
      <Actions busy={busy} ready={complete && !noneKept} label="Save choice" cancel={cancel} />
    </form>
  )
}

function LegacyEditEditor({
  item,
  submit,
  cancel,
  busy
}: {
  item: LegacyEditConflict
  submit: Submit
  cancel(): void
  busy: boolean
}) {
  const [lifecycle, setLifecycle] = useState<LegacyLifecycleChoice | undefined>()
  const [values, setValues] = useState<Record<string, JsonValue>>({})
  const removing = lifecycle?.present === false
  // Removing settles the lifecycle; field choices are then optional.
  const ready =
    (!item.lifecycle || lifecycle !== undefined) &&
    (removing || item.fields.every((field) => field.field in values)) &&
    (!!item.lifecycle || item.fields.length > 0)
  return (
    <form
      className="space-y-3"
      onSubmit={(event) => {
        event.preventDefault()
        void submit({
          kind: 'legacy-edit',
          legacyId: item.legacyId,
          expectedHeads: item.expectedHeads,
          ...(lifecycle
            ? { lifecycle: { present: lifecycle.present, disposition: lifecycle.disposition } }
            : {}),
          values
        })
      }}
    >
      <p className="text-sm">{item.current}</p>
      {item.waiting.map((text) => (
        <p key={text} className="text-sm">
          {text}
        </p>
      ))}
      {item.lifecycle && (
        <fieldset className="space-y-1 text-sm">
          <legend className="font-medium">
            It was kept on one computer and removed or split on another
          </legend>
          {item.lifecycle.map((choice) => (
            <label key={key(choice.disposition)} className="flex items-center gap-2">
              <input
                type="radio"
                name={`${item.key}:lifecycle`}
                checked={
                  lifecycle !== undefined && key(lifecycle.disposition) === key(choice.disposition)
                }
                onChange={() => setLifecycle(choice)}
              />
              {choice.label}
            </label>
          ))}
        </fieldset>
      )}
      {item.fields.map((field) => (
        <Choices
          key={field.field}
          keepAgreed
          name={`${item.key}:${field.field}`}
          field={field}
          value={values[field.field]}
          onChange={(value) => setValues((current) => ({ ...current, [field.field]: value }))}
        />
      ))}
      <Actions busy={busy} ready={ready} label="Save choice" cancel={cancel} />
    </form>
  )
}

function Editor(props: { item: SyncConflictItem; submit: Submit; cancel(): void; busy: boolean }) {
  const { item } = props
  if (item.kind === 'record') return <RecordEditor {...props} item={item} />
  if (item.kind === 'policy') return <PolicyEditor {...props} item={item} />
  if (item.kind === 'session') return <SessionEditor {...props} item={item} />
  if (item.kind === 'legacy') return <LegacyEditor {...props} item={item} />
  if (item.kind === 'legacy-edit') return <LegacyEditEditor {...props} item={item} />
  return <p className="text-sm">{item.explanation}</p>
}

const summary: Record<SyncConflictItem['kind'], string> = {
  record: 'Changed differently on two computers.',
  policy: 'Computers chose different tracking policies.',
  session: 'Shared session edits need a choice. The last agreed values are shown until then.',
  legacy: 'Saved history may be counted twice.',
  'legacy-edit': 'A saved session was changed differently on two computers.',
  held: 'Nothing to choose here. Open for what to do.'
}

export function SyncConflictReview(): React.JSX.Element | null {
  const cache = useQueryClient()
  const presentation = usePresentationMode()
  const review = useQuery({
    queryKey: ['folder-sync', 'conflicts', presentation],
    queryFn: async () => {
      const result = await conflictApi().list({ presentation })
      if (!result.success) throw new Error(result.error.message)
      return result.data
    }
  })
  const [open, setOpen] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notes, setNotes] = useState<string[]>([])
  async function submit(resolution: SyncConflictResolution) {
    setBusy(true)
    setError('')
    setNotes([])
    try {
      const result = await conflictApi().resolve(resolution)
      if (!result.success) {
        setError(result.error.message)
        // A stale review is closed so the refreshed item is reviewed from scratch.
        if (result.error.code === 'SYNC_STALE_REVIEW') setOpen(null)
        return
      }
      setNotes(result.data.followUp)
      setOpen(null)
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'The choice could not be saved.')
    } finally {
      setBusy(false)
      for (const name of [
        'folder-sync',
        'sessions',
        'clients',
        'projects',
        'invoices',
        'workspace-policy',
        'reports'
      ])
        void cache.invalidateQueries({ queryKey: [name] })
    }
  }
  const items = review.data?.items ?? []
  if (!review.error && !items.length && !notes.length) return null
  return (
    <section aria-label="Sync conflicts" className="space-y-3">
      <h3 className="text-sm font-semibold">Needs your choice</h3>
      {(review.error || error) && (
        <p role="alert" className="text-sm">
          {error || review.error?.message}
        </p>
      )}
      {notes.map((note) => (
        <p key={note} className="text-sm">
          {note}
        </p>
      ))}
      <ul className="space-y-3">
        {items.map((item) => (
          <li
            key={item.key}
            className="space-y-2 rounded border border-[var(--surface-border)] p-3"
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <p className="text-sm font-medium">{item.title}</p>
                <p className="text-sm text-[var(--text-muted)]">{summary[item.kind]}</p>
              </div>
              {open !== item.key && (
                <Button
                  variant="outline"
                  disabled={busy}
                  onClick={() => {
                    setError('')
                    setOpen(item.key)
                  }}
                >
                  {item.kind === 'held' ? 'Details' : 'Review'}
                </Button>
              )}
            </div>
            {open === item.key &&
              (item.kind === 'held' ? (
                <>
                  <p className="text-sm">{item.explanation}</p>
                  <Button variant="outline" onClick={() => setOpen(null)}>
                    Close
                  </Button>
                </>
              ) : (
                // Keyed by content: any change to what is shown clears earlier choices.
                <Editor
                  key={JSON.stringify(item)}
                  item={item}
                  submit={submit}
                  cancel={() => setOpen(null)}
                  busy={busy}
                />
              ))}
          </li>
        ))}
      </ul>
    </section>
  )
}
