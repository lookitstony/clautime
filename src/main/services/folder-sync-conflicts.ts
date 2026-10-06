import { createHash, randomUUID } from 'node:crypto'
import { and, eq, inArray } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { AppError } from '../../shared/types/ipc'
import { clientAlias, projectAlias } from '../../shared/presentation-alias'
import { readTrackingPolicy } from '../../shared/tracking-policy'
import type {
  ConflictChoice,
  ConflictField,
  ConflictHeads,
  HeldConflict,
  LegacyConflict,
  LegacyEditConflict,
  LegacyLifecycleChoice,
  PolicyChoice,
  PolicyConflict,
  RecordConflict,
  SessionAssignment,
  SessionConflict,
  SessionConflictValues,
  SessionFragmentConflict,
  SyncConflictItem,
  SyncConflictOutcome,
  SyncConflictResolution,
  SyncConflictReview
} from '../../shared/types/sync-conflict'
import { sessions, type Session } from '../db/schema/sessions'
import { syncChanges, syncRecordStates } from '../db/schema/folder-sync'
import { sessionActivityMappings } from '../db/schema/session-activity-mappings'
import { sessionLegacyRecords } from '../db/schema/session-legacy'
import { providerOperations } from '../db/schema/provider-operations'
import { activeSessionCondition } from '../db/schema/session-deletions'
import { readCanonicalIntervalSnapshot } from './canonical-intervals'
import { canonicalJson, isSyncUuid, SyncError, type SyncChange } from './folder-sync-protocol'
import { syncFactChangeId } from './folder-sync-activity-records'
import { recordLocalSyncChanges, type SyncDomainAdapter } from './folder-sync-store'
import {
  PRESENT,
  RevisionError,
  planRevision,
  type JsonValue,
  type RecordView,
  type RevisionChange
} from './folder-sync-revisions'
import {
  directoryRecordsAdapter,
  getDirectoryRecordView,
  planDirectoryRevision,
  type DirectoryEntityType
} from './folder-sync-directory-records'
import { directorySyncWorkspace } from './folder-sync-directory-local'
import {
  UNASSIGNED_CLIENT_SYNC_ID,
  findClientByPortableId,
  getPortableClientId,
  findProjectByPortableId,
  getPortableProjectId
} from './folder-sync-builtin-client'
import {
  MANUAL_LIFECYCLE_FIELD,
  getManualEntryView,
  isManualSplit,
  journalManualSyncChanges,
  planManualEntryRevision,
  type ManualDisposition
} from './folder-sync-manual-records'
import { syncHistorySuppressions } from '../db/schema/sync-legacy'
import {
  planWorkspacePolicyRevision,
  sharedWorkspacePolicyView,
  workspacePolicySyncAdapter
} from './folder-sync-policy-records'
import { projectSharedWorkspacePolicy } from './folder-sync-policy-projection'
import { readPortableHistoryFacts } from './folder-sync-history-records'
import {
  SESSION_EDIT_SCHEMA,
  journalSessionRecordChanges,
  planPortableSessionEdit,
  planSessionMappingRevision,
  readPortableSessionRecords,
  validateSessionRecordChange,
  type PortableConversationRecords,
  type PortableSessionRecord,
  type PortableSessionTarget,
  type PortableSessionValues,
  type PortableTimeOverride
} from './folder-sync-session-records'
import {
  attachedSessionRecords,
  resolvePortableConversation,
  type PortableConversationResolution,
  type PortableHeldReason,
  type PortableSessionDeletion,
  type PortableSessionFragment
} from './folder-sync-session-overlay'
import { portableCoverageHash } from './folder-sync-portable-coverage'
import {
  journalLegacySyncChanges,
  legacyLifecycle,
  planLegacyReconciliation,
  readLegacyGroups,
  readLegacyQueue,
  readLegacySnapshot,
  refreshLegacyQueue,
  resolveLegacyReferences,
  type LegacyGroup,
  type LegacyQueueEntry,
  type PortableLegacySnapshot
} from './folder-sync-legacy-records'
import {
  effectiveLegacyValues,
  getLegacyEditView,
  planLegacyEditRevision,
  readLegacyEditConflicts,
  validateLegacyEditChange,
  type LegacyDisposition,
  type LegacyEditValues
} from './folder-sync-legacy-edits'
import { invoiceBillingBlockers, type InvoiceBillingBlocker } from './folder-sync-invoice-records'
import { projectSharedSessions } from './folder-sync-session-projection'

/*
 * Conflict review and explicit causal resolution (folder-sync-plan.md decisions E and H).
 *
 * Listing is read-only. Every resolution names exactly what the user was shown: record heads, or a
 * review fingerprint over the conversation's exact session records, the chosen fragment and the
 * directory revisions they reference, or over a saved-history group with its current reviews and
 * each copy's edit heads. Anything changed since is rejected as stale; nothing is chosen,
 * acknowledged or undeleted implicitly, and no clock decides a value. Resolutions are journaled
 * through the domain adapters in one transaction; shared projections refresh after.
 * Invoice and Stripe issues are explained from the invoice adapter's state only; nothing here
 * contacts a provider.
 */

type Db<S extends Record<string, unknown>> = BetterSQLite3Database<S>
type Reader = Pick<Parameters<SyncDomainAdapter['apply']>[0], 'select'>
type Labels = { presentation: boolean }

const PROVIDER_LABELS: Record<string, string> = {
  claude: 'Claude',
  codex: 'Codex',
  gemini: 'Gemini',
  opencode: 'OpenCode'
}
const FIELD_LABELS: Record<string, string> = {
  name: 'Name',
  stageName: 'Presentation name',
  color: 'Color',
  billableRate: 'Hourly rate',
  hourlyRate: 'Hourly rate',
  email: 'Email',
  isActive: 'Active',
  clientSyncId: 'Client',
  projectSyncId: 'Project',
  invoiceName: 'Invoice name',
  isBillable: 'Billable',
  startedAt: 'Start',
  endedAt: 'End',
  durationMinutes: 'Duration',
  description: 'Description',
  billable: 'Billable',
  assignment: 'Client and project',
  time: 'Corrected time'
}
const KNOWN_TYPES = new Set([
  'client',
  'project',
  'manual-entry',
  'workspace-policy',
  'session-mapping',
  'session-edit',
  'legacy-session',
  'legacy-reconciliation',
  'legacy-edit'
])
const INVOICE_TYPES = new Set([
  'invoice',
  'invoice-line',
  'billing-reference',
  'provider-observation',
  'provider-intent'
])
const LEGACY_RESOLUTION_FIELDS = new Set([
  'assignment',
  'startedAt',
  'endedAt',
  'durationMinutes',
  'description',
  'billable'
])
const MAX_TEXT = 4000
const MAX_ECHOED_TEXT = 20_000
const MAX_IDS = 200

function stale(): never {
  throw new AppError(
    'SYNC_STALE_REVIEW',
    'This conflict changed since it was shown. Review it again.'
  )
}

function invalid(message: string): never {
  throw new AppError('SYNC_INVALID_RESOLUTION', message)
}

/** Planner errors surface as a stale review (heads moved) or an invalid resolution. */
function planning<T>(plan: () => T): T {
  try {
    return plan()
  } catch (error) {
    if (error instanceof RevisionError)
      return /Stale resolution/.test(error.message) ? stale() : invalid(error.message)
    if (error instanceof SyncError) invalid(error.message)
    throw error
  }
}

const sha256 = (value: unknown) => createHash('sha256').update(canonicalJson(value)).digest('hex')
const same = (left: unknown, right: unknown) => canonicalJson(left) === canonicalJson(right)
const conversationKey = (target: PortableSessionTarget) =>
  JSON.stringify([target.provider, target.conversationId])

function normalHeads(heads: Readonly<Record<string, readonly string[]>>): ConflictHeads {
  return Object.fromEntries(
    Object.keys(heads)
      .sort()
      .map((field) => [field, [...heads[field]].sort()])
  )
}

function workspaceOf<S extends Record<string, unknown>>(db: Db<S>): string {
  const workspaceId = directorySyncWorkspace(db)
  if (!workspaceId) throw new AppError('SYNC_NOT_CONNECTED', 'Connect shared history first.')
  return workspaceId
}

// ── Labels (human text only) ──

function instant(value: string): string {
  const at = new Date(value)
  return Number.isFinite(at.getTime())
    ? `${at.toISOString().slice(0, 16).replace('T', ' ')} UTC`
    : value
}

function clientLabel(db: Reader, syncId: string | null, labels: Labels): string {
  if (syncId === null || syncId === UNASSIGNED_CLIENT_SYNC_ID) return 'Unassigned'
  const row = findClientByPortableId(db, syncId)
  if (!row) return 'A client not on this computer yet'
  if (labels.presentation) return row.stageName ?? clientAlias(row.id)
  return row.name
}

function projectLabel(db: Reader, syncId: string | null, labels: Labels): string {
  if (syncId === null) return 'No project'
  const row = findProjectByPortableId(db, syncId)
  if (!row) return 'A project not on this computer yet'
  if (labels.presentation) return row.stageName ?? projectAlias(row.id)
  return row.name
}

function timeLabel(value: JsonValue): string {
  if (value === null) return 'No corrected time'
  const time = value as unknown as PortableTimeOverride
  const parts = [
    time.startedAt && `starts ${instant(time.startedAt)}`,
    time.endedAt && `ends ${instant(time.endedAt)}`,
    time.durationMinutes !== undefined && `${time.durationMinutes} min`
  ].filter(Boolean)
  return parts.length ? parts.join(', ') : 'No corrected time'
}

function valueLabel(db: Reader, field: string, value: JsonValue, labels: Labels): string {
  if (field === 'clientSyncId') return clientLabel(db, value as string | null, labels)
  if (field === 'projectSyncId') return projectLabel(db, value as string | null, labels)
  if (field === 'assignment') {
    const pair = value as unknown as SessionAssignment
    return `${clientLabel(db, pair.clientSyncId, labels)} / ${projectLabel(db, pair.projectSyncId, labels)}`
  }
  if (field === 'time') return timeLabel(value)
  if (value === null) return 'None'
  if (field === 'isActive') return value ? 'Active' : 'Inactive'
  if (typeof value === 'boolean') return value ? 'Yes' : 'No'
  if (field === 'startedAt' || field === 'endedAt') return instant(String(value))
  if (field === 'durationMinutes') return `${value} min`
  if (field === 'billableRate' || field === 'hourlyRate') return `${value} per hour`
  if (labels.presentation && (field === 'name' || field === 'email'))
    return 'Hidden while presenting'
  return typeof value === 'string' ? value : canonicalJson(value)
}

function choices(
  db: Reader,
  field: string,
  values: readonly JsonValue[],
  labels: Labels
): ConflictChoice[] {
  const seen = new Map<string, ConflictChoice>()
  for (const value of values)
    if (!seen.has(canonicalJson(value)))
      seen.set(canonicalJson(value), { value, label: valueLabel(db, field, value, labels) })
  const list = [...seen.values()]
  // Masked or equal-looking labels stay distinguishable without showing the hidden value.
  return list.map((choice, index) =>
    list.filter((other) => other.label === choice.label).length > 1
      ? { ...choice, label: `${choice.label} (option ${index + 1})` }
      : choice
  )
}

/** Duplicate titles get a short identity suffix; unique titles never show an ID. */
function disambiguate(items: SyncConflictItem[]): SyncConflictItem[] {
  const counts = new Map<string, number>()
  for (const item of items) counts.set(item.title, (counts.get(item.title) ?? 0) + 1)
  return items.map((item) =>
    (counts.get(item.title) ?? 0) > 1
      ? { ...item, title: `${item.title} (${sha256(item.key).slice(0, 6)})` }
      : item
  )
}

// ── Records: clients, projects, manual entries ──

function recordFields(db: Reader, view: RecordView, labels: Labels): ConflictField[] {
  // A manual entry's disposition is chosen with its lifecycle, never as a value.
  const conflicted = view.conflicts.filter(
    (field) => field !== PRESENT && field !== MANUAL_LIFECYCLE_FIELD
  )
  // Client and project are written together on manual entries.
  if (
    view.entityType === 'manual-entry' &&
    conflicted.some((field) => field === 'clientSyncId' || field === 'projectSyncId')
  )
    for (const field of ['clientSyncId', 'projectSyncId'])
      if (!conflicted.includes(field)) conflicted.push(field)
  return conflicted.map((field) => {
    const state = view.fields[field]
    const values =
      state.status === 'conflict' ? state.heads.map((head) => head.value) : [state.value ?? null]
    return {
      field,
      label: FIELD_LABELS[field] ?? field,
      lastAgreed:
        state.value !== undefined
          ? { value: state.value, label: valueLabel(db, field, state.value, labels) }
          : null,
      alternatives: choices(db, field, values, labels)
    }
  })
}

function recordTitle(db: Reader, view: RecordView, labels: Labels): string {
  const value = (field: string): JsonValue | undefined =>
    view.fields[field]?.value ?? view.fields[field]?.heads[0]?.value
  if (view.entityType === 'client') {
    const row = findClientByPortableId(db, view.entityId)
    if (labels.presentation)
      return `Client ${row ? (row.stageName ?? clientAlias(row.id)) : ''}`.trim()
    return `Client ${String(value('name') ?? '')}`.trim()
  }
  if (view.entityType === 'project') {
    const row = findProjectByPortableId(db, view.entityId)
    if (labels.presentation)
      return `Project ${row ? (row.stageName ?? projectAlias(row.id)) : ''}`.trim()
    return `Project ${String(value('name') ?? '')}`.trim()
  }
  const started = value('startedAt')
  return `Manual time${typeof started === 'string' ? ` from ${instant(started)}` : ''}`
}

function manualDispositionLabel(value: JsonValue): string {
  const disposition = value as unknown as ManualDisposition
  return disposition.kind === 'split'
    ? `Split it at ${instant(disposition.splitAt)} into ${disposition.children.length} parts that count instead`
    : 'Delete it (kept for audit, no longer counted)'
}

/**
 * A manual entry kept, deleted and split differently: keep it, or exactly one of the removals
 * currently recorded; never a combination. A plain deletion and a split are different choices.
 */
function manualLifecycleChoices(view: RecordView): LegacyLifecycleChoice[] | null {
  if (view.entityType !== 'manual-entry') return null
  if (!view.conflicts.includes(PRESENT) && !view.conflicts.includes(MANUAL_LIFECYCLE_FIELD))
    return null
  const found = new Map<string, LegacyLifecycleChoice>([
    ['null', { present: true, disposition: null, label: 'Keep it counting as one entry' }]
  ])
  for (const head of view.fields[MANUAL_LIFECYCLE_FIELD]?.heads ?? [])
    if (head.value !== null && !found.has(canonicalJson(head.value)))
      found.set(canonicalJson(head.value), {
        present: false,
        disposition: head.value,
        label: manualDispositionLabel(head.value)
      })
  return [...found.values()]
}

function recordConflict(db: Reader, view: RecordView, labels: Labels): RecordConflict | null {
  const lifecycle = manualLifecycleChoices(view)
  if (
    !view.conflicts.length ||
    (view.lifecycle !== 'present' && view.lifecycle !== 'conflict' && !lifecycle)
  )
    return null
  const parts = new Set(
    (lifecycle ?? []).flatMap((choice) =>
      isManualSplit(choice.disposition) ? choice.disposition.children : []
    )
  )
  return {
    kind: 'record',
    key: `${view.entityType}:${view.entityId}`,
    entityType: view.entityType as RecordConflict['entityType'],
    entityId: view.entityId,
    title: recordTitle(db, view, labels),
    lifecycleConflict: view.lifecycle === 'conflict' || !!lifecycle,
    fields: recordFields(db, view, labels),
    expectedHeads: normalHeads(view.heads),
    ...(lifecycle
      ? {
          lifecycleChoices: lifecycle,
          waiting: parts.size
            ? [`${parts.size} part(s) split from it do not count until you choose.`]
            : []
        }
      : {})
  }
}

/** Manual split parts waiting for a split that is not shown with a choice (not arrived yet). */
function manualPartsHeld(
  db: Reader,
  workspaceId: string,
  shown: ReadonlySet<string>
): HeldConflict[] {
  const byParent = new Map<string, number[]>()
  for (const row of db
    .select()
    .from(syncHistorySuppressions)
    .where(
      and(
        eq(syncHistorySuppressions.workspaceId, workspaceId),
        eq(syncHistorySuppressions.recordType, 'manual-entry'),
        eq(syncHistorySuppressions.status, 'queued')
      )
    )
    .orderBy(syncHistorySuppressions.recordId)
    .all()) {
    const splitFrom = (JSON.parse(row.detailJson) as { splitFrom?: unknown }).splitFrom
    if (typeof splitFrom === 'string' && !shown.has(splitFrom))
      byParent.set(splitFrom, [...(byParent.get(splitFrom) ?? []), row.sessionId])
  }
  return [...byParent].map(([parent, sessionIds]) => {
    const row = db.select().from(sessions).where(eq(sessions.id, sessionIds[0])).get()
    return {
      kind: 'held' as const,
      key: `manual-parts:${parent}`,
      title: `${sessionIds.length} part(s) of a split manual entry${row ? ` from ${instant(row.startedAt)}` : ''}`,
      explanation:
        'These parts come from a split made on another computer that has not fully reached this computer. Until it has, they do not count and the entry they were split from keeps its current state. Syncing the other computer usually settles it.'
    }
  })
}

function recordView(
  db: Reader,
  workspaceId: string,
  entityType: RecordConflict['entityType'],
  entityId: string
) {
  return entityType === 'manual-entry'
    ? getManualEntryView(db, workspaceId, entityId)
    : getDirectoryRecordView(db, workspaceId, entityType, entityId)
}

// ── Policy ──

function policyChoice(value: JsonValue): PolicyChoice | null {
  try {
    const policy = readTrackingPolicy(value)
    return {
      value,
      label: `Reporting time zone ${policy.reportingTimeZone}; a session ends after ${policy.idleTimeoutMinutes} idle minutes`,
      reportingTimeZone: policy.reportingTimeZone,
      idleTimeoutMinutes: policy.idleTimeoutMinutes
    }
  } catch {
    return null
  }
}

function policyConflict(db: Reader, workspaceId: string): PolicyConflict | null {
  const view = sharedWorkspacePolicyView(db, workspaceId)
  if (view.lifecycle === 'missing' || !view.conflicts.length) return null
  const state = view.fields.policy
  const alternatives = new Map<string, PolicyChoice>()
  for (const head of state.heads) {
    const choice = policyChoice(head.value)
    if (choice) alternatives.set(canonicalJson(head.value), choice)
  }
  return {
    kind: 'policy',
    key: `workspace-policy:${workspaceId}`,
    title: 'Tracking policy',
    lastAgreed: state.value !== undefined ? policyChoice(state.value) : null,
    alternatives: [...alternatives.values()],
    expectedHeads: normalHeads(view.heads)
  }
}

// ── Sessions ──

interface ConversationContext {
  target: PortableSessionTarget
  key: string
  records: PortableConversationRecords
  entries: Array<{ row: Session; fragment: PortableSessionFragment; hash: string }>
  deletions: readonly PortableSessionDeletion[]
  cuts: string[]
  resolution: PortableConversationResolution
}

function mappedConversations(db: Reader): Map<string, PortableSessionTarget> {
  const found = new Map<string, PortableSessionTarget>()
  for (const row of db.select().from(sessionActivityMappings).all()) {
    const target = { provider: row.provider, conversationId: row.conversationId }
    found.set(conversationKey(target), target)
  }
  return found
}

function readConversation(
  db: Reader,
  workspaceId: string,
  target: PortableSessionTarget
): ConversationContext {
  const key = conversationKey(target)
  const mappings = db
    .select()
    .from(sessionActivityMappings)
    .where(
      and(
        eq(sessionActivityMappings.provider, target.provider),
        eq(sessionActivityMappings.conversationId, target.conversationId)
      )
    )
    .all()
  const rows = mappings.length
    ? db
        .select()
        .from(sessions)
        .where(
          and(
            inArray(
              sessions.id,
              mappings.map((row) => row.sessionId)
            ),
            activeSessionCondition
          )
        )
        .all()
    : []
  const byId = new Map(rows.map((row) => [row.id, row]))
  const entries = mappings
    .flatMap((mapping) => {
      const row = byId.get(mapping.sessionId)
      const interval = row && readCanonicalIntervalSnapshot(mapping.intervalJson, mapping.provider)
      if (!row || !interval) return []
      const fragment = { startedAt: interval.startedAt, coverage: interval.coverage }
      return [
        {
          row,
          fragment,
          hash: portableCoverageHash(target.provider, target.conversationId, interval.coverage)
        }
      ]
    })
    .sort(
      (left, right) => Date.parse(left.fragment.startedAt) - Date.parse(right.fragment.startedAt)
    )
  const facts = readPortableHistoryFacts(db as never, [key], workspaceId).get(key)
  const records = readPortableSessionRecords(db, workspaceId, target)
  const deletions = facts?.deletions ?? []
  const resolution = resolvePortableConversation({
    target: records.target,
    mapping: records.mapping,
    edits: records.edits,
    fragments: entries.map((entry) => entry.fragment),
    deletions,
    directory: (entityType, syncId) => getDirectoryRecordView(db, workspaceId, entityType, syncId)
  })
  return {
    target,
    key,
    records,
    entries,
    deletions,
    cuts: facts?.cuts.map((cut) => cut.splitAt) ?? [],
    resolution
  }
}

/**
 * The exact state a session choice was shown with: every record's heads and lifecycle, the
 * fragment, the conversation's deletions and the heads of every client/project the records name.
 */
function sessionFingerprint(workspaceId: string, db: Reader, context: ConversationContext): string {
  const referenced = new Set<string>()
  for (const record of [context.records.mapping, ...context.records.edits]) {
    if (!record) continue
    for (const [field, entityType] of [
      ['clientSyncId', 'client'],
      ['projectSyncId', 'project']
    ] as const)
      for (const head of record.view.fields[field]?.heads ?? [])
        if (typeof head.value === 'string') referenced.add(`${entityType}\0${head.value}`)
  }
  return sha256({
    version: 1,
    target: context.target,
    fragments: context.entries.map((entry) => entry.hash),
    records: [context.records.mapping, ...context.records.edits]
      .filter((record): record is PortableSessionRecord => !!record)
      .map((record) => [record.entityId, record.view.lifecycle, normalHeads(record.view.heads)]),
    deletions: context.deletions.map((deletion) => deletion.operationId).sort(),
    directory: [...referenced].sort().map((item) => {
      const [entityType, syncId] = item.split('\0') as [DirectoryEntityType, string]
      return [item, normalHeads(getDirectoryRecordView(db, workspaceId, entityType, syncId).heads)]
    })
  })
}

function reasonText(reason: PortableHeldReason): string {
  switch (reason.code) {
    case 'metadata-choice-required':
      return `Different computers set a different ${(FIELD_LABELS[reason.field] ?? reason.field).toLowerCase()} for this session.`
    case 'time-override-in-split-or-merge':
      return 'A corrected time was made on a different version of this session (before a split or merge).'
    case 'field-conflict':
      return `${reason.fields.map((field) => FIELD_LABELS[field] ?? field).join(', ')} changed on two computers at once.`
    case 'edit-lifecycle-conflict':
      return "This session's edits were changed on one computer and removed on another."
    case 'post-split-edit':
      return 'The original session was edited after this part was split off.'
    case 'mapping-conflict':
      return "The conversation's client and project were changed on two computers."
  }
}

/** Values each attached record (or the mapping) holds for a portable field, including conflicts. */
function fieldValues(records: readonly PortableSessionRecord[], field: string): JsonValue[] {
  const values: JsonValue[] = []
  for (const record of records) {
    const state = record.view.fields[field]
    if (state?.status === 'conflict') values.push(...state.heads.map((head) => head.value))
    else if (state?.status === 'resolved') values.push(state.value as JsonValue)
  }
  return values
}

function assignmentValues(records: readonly PortableSessionRecord[]): JsonValue[] {
  const pairs: JsonValue[] = []
  const unassigned = (value: JsonValue) => (value === UNASSIGNED_CLIENT_SYNC_ID ? null : value)
  for (const record of records) {
    const client = record.view.fields.clientSyncId
    const project = record.view.fields.projectSyncId
    if (!client || !project) continue
    // Client and project are always written by the same revision, so heads pair by change ID.
    for (const head of client.heads) {
      const partner = project.heads.find((item) => item.id === head.id)
      if (partner)
        pairs.push({ clientSyncId: unassigned(head.value), projectSyncId: partner.value })
    }
  }
  return pairs
}

function fragmentConflict(
  db: Reader,
  context: ConversationContext,
  index: number,
  labels: Labels
): SessionFragmentConflict | null {
  const resolution = context.resolution.fragments[index]
  const entry = context.entries[index]
  if (!resolution.reasons.length) return null
  const attached = attachedSessionRecords(entry.fragment, context.records.edits)
  const sources = [...attached, ...(context.records.mapping ? [context.records.mapping] : [])]
  const fields: ConflictField[] = []
  const held = (field: 'clientSyncId' | 'projectSyncId' | 'description' | 'billable' | 'time') =>
    resolution.fields[field].status === 'held'
  const add = (field: string, values: JsonValue[], current: JsonValue) =>
    fields.push({
      field,
      label: FIELD_LABELS[field],
      lastAgreed: { value: current, label: valueLabel(db, field, current, labels) },
      alternatives: choices(db, field, values, labels)
    })
  const row = entry.row
  if (held('clientSyncId') || held('projectSyncId'))
    add('assignment', assignmentValues(sources), currentAssignment(db, row))
  if (held('description'))
    add('description', fieldValues(attached, 'description'), row.description ?? null)
  if (held('billable')) add('billable', fieldValues(attached, 'billable'), !!row.billable)
  if (held('time')) add('time', fieldValues(attached, 'time'), null)
  const copyEdits = resolution.reasons.flatMap((reason) =>
    reason.code === 'post-split-edit'
      ? [
          {
            entityId: reason.entityId,
            source: reason.source,
            revisions: reason.revisions,
            summary: `${reason.revisions.length} change(s) to the original session after this part was split off.`
          }
        ]
      : []
  )
  return {
    fragmentHash: entry.hash,
    title: `${instant(row.startedAt)} to ${instant(row.endedAt)}`,
    reasons: [...new Set(resolution.reasons.map(reasonText))],
    fields,
    lifecycleConflict: resolution.reasons.some(
      (reason) => reason.code === 'edit-lifecycle-conflict'
    ),
    copyEdits,
    current: {
      assignment: valueLabel(db, 'assignment', currentAssignment(db, row), labels),
      description: row.description ?? null,
      billable: !!row.billable,
      startedAt: row.startedAt,
      endedAt: row.endedAt,
      durationMinutes: row.durationMinutes
    }
  }
}

/** The row's last agreed assignment in portable spelling (the built-in Unassigned is null). */
function currentAssignment(db: Reader, row: Session): JsonValue {
  const client = row.clientId === null ? null : getPortableClientId(db, row.clientId)
  const project = row.projectId === null ? null : getPortableProjectId(db, row.projectId)
  return {
    clientSyncId: client === UNASSIGNED_CLIENT_SYNC_ID ? null : client,
    projectSyncId: project
  }
}

/**
 * An edit whose anchor no fragment here contains. Placement follows only from its anchor, so it
 * attaches by itself once the missing activity or split arrives. Nothing is offered: retiring it
 * here would also remove it on computers where it does attach, and moving it to a fragment would
 * be a guess. Re-entering the values with an ordinary edit is the supported way to apply them now.
 */
function orphanText(db: Reader, record: PortableSessionRecord, labels: Labels): string {
  const anchor = record.view.fields.anchor?.value as { kind?: string; splitAt?: string } | undefined
  const where =
    anchor?.kind === 'cut' && anchor.splitAt
      ? `the part starting ${instant(anchor.splitAt)}`
      : 'activity this computer has not matched to a session yet'
  const resolved = (field: string): JsonValue | undefined => {
    const state = record.view.fields[field]
    return state?.status === 'resolved' ? state.value : undefined
  }
  const sets: string[] = []
  if (resolved('clientSyncId') !== undefined && resolved('projectSyncId') !== undefined)
    sets.push(
      `client and project ${valueLabel(db, 'assignment', { clientSyncId: resolved('clientSyncId')!, projectSyncId: resolved('projectSyncId')! }, labels)}`
    )
  const description = resolved('description')
  if (typeof description === 'string') sets.push(`description "${description}"`)
  const billable = resolved('billable')
  if (typeof billable === 'boolean') sets.push(billable ? 'billable' : 'not billable')
  const time = resolved('time')
  if (time) sets.push(`corrected time (${timeLabel(time)})`)
  return [
    `A shared edit for ${where} cannot be placed on this computer yet${sets.length ? `. It sets: ${sets.join('; ')}` : ''}.`,
    "It is placed automatically once the other computer's history arrives, usually with its next sync, and it does not change totals or billing here until then.",
    'To use these values now, edit the session as usual; the shared edit stays recorded either way.'
  ].join(' ')
}

function sessionConflict(
  db: Reader,
  workspaceId: string,
  target: PortableSessionTarget,
  labels: Labels
): SessionConflict | null {
  const context = readConversation(db, workspaceId, target)
  const { records, resolution } = context
  if (!records.mapping && !records.edits.length) return null
  const fragments = context.entries
    .map((_, index) => fragmentConflict(db, context, index, labels))
    .filter((item): item is SessionFragmentConflict => !!item)
  const mappingView = records.mapping?.view
  const mapping =
    mappingView && (mappingView.lifecycle === 'conflict' || mappingView.conflicts.length)
      ? {
          expectedHeads: normalHeads(mappingView.heads),
          alternatives: choices(db, 'assignment', assignmentValues([records.mapping!]), labels)
        }
      : null
  const deletions = resolution.deletionConflicts.map((conflict) => ({
    operationId: conflict.operationId,
    entityId: conflict.entityId,
    summary:
      'This session was deleted on another computer while it was being edited. Keeping the deletion means that edit no longer applies; it stays recorded in the shared history.'
  }))
  const held = resolution.orphaned.flatMap((entityId) => {
    const record = records.edits.find((item) => item.entityId === entityId)
    return record ? [orphanText(db, record, labels)] : []
  })
  if (!fragments.length && !mapping && !deletions.length && !held.length) return null
  const first = context.entries[0]?.row
  return {
    kind: 'session',
    key: `session:${context.key}`,
    provider: target.provider,
    conversationId: target.conversationId,
    title: `${PROVIDER_LABELS[target.provider] ?? 'Assistant'} conversation${first ? ` from ${instant(first.startedAt)}` : ''}`,
    reviewFingerprint: sessionFingerprint(workspaceId, db, context),
    fragments,
    mapping,
    deletions,
    held
  }
}

// ── Legacy: possibly duplicated saved history ──

interface LegacyTarget {
  provider: string
  conversationId: string
}

function legacyTarget(
  db: Reader,
  workspaceId: string,
  entry: LegacyQueueEntry
): LegacyTarget | null {
  const snapshot = readLegacySnapshot(db, workspaceId, entry.legacyId)
  if (snapshot)
    return snapshot.conversationId
      ? { provider: snapshot.provider, conversationId: snapshot.conversationId }
      : null
  const row = db.select().from(sessions).where(eq(sessions.id, entry.sessionId)).get()
  return row?.claudeSessionId ? { provider: row.tool, conversationId: row.claudeSessionId } : null
}

/**
 * The exact state a duplicate review was shown with: the group, whether activity overlaps it,
 * its current (possibly disagreeing) reviews and the decision in force, and each copy's edit heads.
 */
function legacyFingerprint(db: Reader, workspaceId: string, group: LegacyGroup): string {
  return sha256({
    version: 1,
    provider: group.provider,
    conversationId: group.conversationId,
    candidates: group.candidates,
    activityOverlap: group.activityOverlap,
    heads: group.heads,
    decision: group.decision,
    members: group.members.map((member) => [
      member.legacyId,
      member.native,
      normalHeads(getLegacyEditView(db, workspaceId, member.legacyId).heads)
    ])
  })
}

function legacyCopyLabel(
  db: Reader,
  workspaceId: string,
  group: LegacyGroup,
  legacyId: string
): string {
  const member = group.members.find((item) => item.legacyId === legacyId)
  const origin = member?.native ? 'Saved on this computer' : 'From another computer'
  const snapshot = readLegacySnapshot(db, workspaceId, legacyId)
  if (snapshot) {
    const values = effectiveLegacyValues(getLegacyEditView(db, workspaceId, legacyId), snapshot)
    return `${instant(values.startedAt)} to ${instant(values.endedAt)}, ${values.durationMinutes} min, ${snapshot.promptCount} prompt(s). ${origin}.`
  }
  const row = member?.sessionId
    ? db.select().from(sessions).where(eq(sessions.id, member.sessionId)).get()
    : undefined
  const times = row
    ? `${instant(row.startedAt)} to ${instant(row.endedAt)}, ${row.durationMinutes} min. `
    : ''
  return `${times}${origin}, not shared yet. Sync before choosing.`
}

function legacyExplanation(group: LegacyGroup): string {
  const { decision } = group
  const until = decision.conflict
    ? decision.agreed
      ? 'Two computers reviewed these copies differently. Until you choose, the earlier review they both agreed on still applies.'
      : 'Two computers reviewed these copies differently, and there is no earlier review they agreed on. Until you choose, copies saved on this computer count and copies from other computers do not.'
    : 'Until you choose, copies saved on this computer count and copies from other computers do not.'
  return [
    group.candidates.length > 1 && 'Several saved copies of this conversation cover the same time.',
    group.activityOverlap && 'Saved history covers time that recorded activity already counts.',
    until,
    'Nothing is matched by name or time automatically. Copies you mark as duplicates stop counting but stay saved.'
  ]
    .filter(Boolean)
    .join(' ')
}

function legacyConflict(
  db: Reader,
  workspaceId: string,
  group: LegacyGroup,
  counting: ReadonlyMap<string, boolean>
): LegacyConflict {
  const number = (ids: readonly string[]) =>
    ids.length ? ids.map((id) => `copy ${group.candidates.indexOf(id) + 1}`).join(', ') : 'none'
  const first = readLegacySnapshot(db, workspaceId, group.candidates[0])
  return {
    kind: 'legacy',
    key: `legacy:${canonicalJson([group.provider, group.conversationId, group.candidates])}`,
    provider: group.provider,
    conversationId: group.conversationId,
    title: `Saved ${PROVIDER_LABELS[group.provider] ?? 'assistant'} history${first ? ` from ${instant(first.startedAt)}` : ''}`,
    explanation: legacyExplanation(group),
    candidates: group.candidates.map((legacyId) => ({
      legacyId,
      label: legacyCopyLabel(db, workspaceId, group, legacyId),
      // Members absent from the queue are not held: they count.
      counting: counting.get(legacyId) ?? true
    })),
    previousReviews: group.decision.conflict
      ? group.heads.map((head) => ({
          label: `Keep ${number(head.keep)}; duplicates: ${number(head.duplicates)}`,
          keep: head.keep,
          duplicates: head.duplicates
        }))
      : [],
    activityOverlap: group.activityOverlap,
    reviewFingerprint: legacyFingerprint(db, workspaceId, group)
  }
}

function legacyConflicts(
  db: Reader,
  workspaceId: string,
  queue: readonly LegacyQueueEntry[]
): LegacyConflict[] {
  const review = queue.filter(
    (entry) => entry.status !== 'duplicate' && !entry.reasons.includes('pending-split')
  )
  const wanted = new Set(review.map((entry) => canonicalJson(entry.candidates)))
  const counting = new Map(queue.map((entry) => [entry.legacyId, entry.counting]))
  const targets = new Map<string, LegacyTarget>()
  for (const entry of review) {
    const target = legacyTarget(db, workspaceId, entry)
    if (target) targets.set(JSON.stringify([target.provider, target.conversationId]), target)
  }
  const items: LegacyConflict[] = []
  for (const { provider, conversationId } of targets.values())
    for (const group of readLegacyGroups(db, workspaceId, provider, conversationId))
      if (group.needsReview && wanted.has(canonicalJson(group.candidates)))
        items.push(legacyConflict(db, workspaceId, group, counting))
  return items
}

// ── Legacy: edits and lifecycle of one saved session ──

const LEGACY_VALUE_FIELDS = [
  'startedAt',
  'endedAt',
  'durationMinutes',
  'description',
  'billable'
] as const

function dispositionLabel(value: JsonValue): string {
  const disposition = value as unknown as LegacyDisposition
  switch (disposition.kind) {
    case 'deleted':
      return 'Remove it from totals (it stays saved for audit)'
    case 'split':
      return `Split it at ${instant(disposition.splitAt)} into ${disposition.children.length} parts that count instead`
    case 'adopted':
      return 'Count this time through recorded activity instead (it stays saved for audit)'
    case 'replaced':
      return 'Use the recalculated session instead (it stays saved for audit)'
  }
}

/** Keep, or exactly one of the removals currently recorded; never a combination. */
function legacyLifecycleChoices(view: RecordView): LegacyLifecycleChoice[] | null {
  if (!view.conflicts.includes(PRESENT) && !view.conflicts.includes('disposition')) return null
  const found = new Map<string, LegacyLifecycleChoice>([
    ['null', { present: true, disposition: null, label: 'Keep it counting as one saved session' }]
  ])
  for (const head of view.fields.disposition?.heads ?? [])
    if (head.value !== null && !found.has(canonicalJson(head.value)))
      found.set(canonicalJson(head.value), {
        present: false,
        disposition: head.value,
        label: dispositionLabel(head.value)
      })
  return [...found.values()]
}

function legacyEditFields(
  db: Reader,
  view: RecordView,
  snapshot: PortableLegacySnapshot,
  labels: Labels
): ConflictField[] {
  const agreed = effectiveLegacyValues(view, snapshot)
  const field = (name: string, values: JsonValue[], current: JsonValue): ConflictField => ({
    field: name,
    label: FIELD_LABELS[name] ?? name,
    lastAgreed: { value: current, label: valueLabel(db, name, current, labels) },
    alternatives: choices(db, name, values, labels)
  })
  const fields: ConflictField[] = []
  if (view.conflicts.includes('clientSyncId') || view.conflicts.includes('projectSyncId')) {
    // Both are always written by the same revision, so heads pair by change ID.
    const project = view.fields.projectSyncId.heads
    const pairs = view.fields.clientSyncId.heads.flatMap((head) => {
      const partner = project.find((item) => item.id === head.id)
      return partner ? [{ clientSyncId: head.value, projectSyncId: partner.value }] : []
    })
    fields.push(
      field('assignment', pairs, {
        clientSyncId: agreed.clientSyncId,
        projectSyncId: agreed.projectSyncId
      })
    )
  }
  for (const name of LEGACY_VALUE_FIELDS)
    if (view.conflicts.includes(name))
      fields.push(
        field(
          name,
          view.fields[name].heads.map((head) => head.value),
          agreed[name]
        )
      )
  return fields
}

function legacySessionRow(db: Reader, legacyId: string): Session | undefined {
  const legacy = db
    .select({ sessionId: sessionLegacyRecords.sessionId })
    .from(sessionLegacyRecords)
    .where(eq(sessionLegacyRecords.id, legacyId))
    .get()
  return legacy
    ? db.select().from(sessions).where(eq(sessions.id, legacy.sessionId)).get()
    : undefined
}

function countsHere(db: Reader, sessionId: number): boolean {
  return !!db
    .select({ id: sessions.id })
    .from(sessions)
    .where(and(eq(sessions.id, sessionId), activeSessionCondition))
    .get()
}

function legacyEditConflicts(
  db: Reader,
  workspaceId: string,
  pending: ReadonlyMap<string, number>,
  labels: Labels
): LegacyEditConflict[] {
  return readLegacyEditConflicts(db, workspaceId).flatMap(({ legacyId }) => {
    const view = getLegacyEditView(db, workspaceId, legacyId)
    const snapshot = readLegacySnapshot(db, workspaceId, legacyId)
    if (!view.conflicts.length || !snapshot) return []
    const agreed = effectiveLegacyValues(view, snapshot)
    const row = legacySessionRow(db, legacyId)
    const lifecycle = legacyLifecycleChoices(view)
    // Parts wait on this choice only when one of its options is a split.
    const splitChoice = lifecycle?.some(
      (choice) => (choice.disposition as { kind?: string } | null)?.kind === 'split'
    )
    const parts = splitChoice ? (pending.get(legacyId) ?? 0) : 0
    return [
      {
        kind: 'legacy-edit' as const,
        key: `legacy-edit:${legacyId}`,
        legacyId,
        title: `Saved ${PROVIDER_LABELS[snapshot.provider] ?? 'assistant'} session from ${instant(agreed.startedAt)}`,
        current:
          row && countsHere(db, row.id)
            ? 'Until you choose, it keeps its last agreed values and counts in totals.'
            : 'Until you choose, it keeps its last agreed values. It does not count on this computer right now.',
        lifecycle,
        fields: legacyEditFields(db, view, snapshot, labels),
        waiting: parts ? [`${parts} part(s) split from it do not count until you choose.`] : [],
        expectedHeads: normalHeads(view.heads)
      }
    ]
  })
}

/** Split parts waiting for a parent that is not itself shown with a choice. */
function legacyPartsHeld(
  db: Reader,
  workspaceId: string,
  queue: readonly LegacyQueueEntry[],
  shown: ReadonlySet<string>
): HeldConflict[] {
  const byParent = new Map<string, LegacyQueueEntry[]>()
  for (const entry of queue)
    if (entry.splitFrom && entry.reasons.includes('pending-split') && !shown.has(entry.splitFrom))
      byParent.set(entry.splitFrom, [...(byParent.get(entry.splitFrom) ?? []), entry])
  return [...byParent].map(([parent, entries]) => {
    const state = legacyLifecycle(db, workspaceId, parent).state
    const settled = state === 'deleted' || state === 'retired'
    const row = db.select().from(sessions).where(eq(sessions.id, entries[0].sessionId)).get()
    return {
      kind: 'held' as const,
      key: `legacy-parts:${parent}`,
      title: `${entries.length} part(s) of a split saved session${row ? ` from ${instant(row.startedAt)}` : ''}`,
      explanation: settled
        ? 'The saved session these parts were split from was removed or split differently, so they do not count. They stay saved for audit.'
        : 'These parts come from a split made on another computer that has not reached this computer, or has not been agreed. Until it has, the whole saved session counts and these parts do not. Syncing the other computer usually settles it.'
    }
  })
}

// ── Held: invoices and record types this build cannot resolve here ──

const INVOICE_EXPLANATIONS: Record<InvoiceBillingBlocker['reason'], string> = {
  'client-unavailable':
    "This invoice's client has not reached this computer yet. Sync the computer that created the invoice. Until then, new invoices for this client are paused here.",
  'lines-incomplete':
    'Some lines of this invoice have not reached this computer yet. Sync the computer that created it. Until then, new invoices for this client are paused here.',
  'header-conflict':
    'Two computers saved different amounts, clients or lines for this issued invoice. Each computer keeps the copy it already had, and nothing is changed in Stripe. ClauTime cannot combine them here; compare the invoice in your Stripe dashboard. New invoices for this client are paused on this computer while the copies differ.',
  'line-conflict':
    'Two computers saved different lines for this issued invoice. Each computer keeps the copy it already had, and nothing is changed in Stripe. ClauTime cannot combine them here; compare the invoice in your Stripe dashboard. New invoices for this client are paused on this computer while the copies differ.',
  'account-conflict':
    'This computer already has an invoice with the same Stripe number under a different Stripe account. It is kept as it is. Check that every computer is connected to the same Stripe account.',
  'mode-conflict':
    'This computer already has an invoice with the same Stripe number, but one of them is a test invoice. It is kept as it is. Check the test mode setting on each computer.',
  'terminal-status-conflict':
    'One computer saw this invoice as paid and another as void. It keeps its current status here. Settling it needs a fresh read from Stripe: open the invoice on the Invoices page and choose Refresh. If Refresh is not offered because the invoice shows as paid or void, check it in your Stripe dashboard. New invoices for this client are paused here until then.',
  'provider-intent-conflict':
    'Two computers recorded different details for the same Stripe action. ClauTime does not retry or continue it on its own. Check the invoice in your Stripe dashboard before creating another one for this client.'
}

const OPERATION_TITLES: Record<string, string> = {
  'create-invoice': 'Creating an invoice in Stripe',
  'send-invoice': 'Sending an invoice',
  'void-invoice': 'Voiding an invoice',
  'sync-customer': 'Updating a client in Stripe'
}

function invoiceTitle(db: Reader, workspaceId: string, invoiceId: string, labels: Labels): string {
  const row = db
    .select({ json: syncChanges.changeJson })
    .from(syncChanges)
    .where(
      and(
        eq(syncChanges.workspaceId, workspaceId),
        eq(syncChanges.entityType, 'invoice'),
        eq(syncChanges.entityId, invoiceId)
      )
    )
    .orderBy(syncChanges.id)
    .get()
  if (!row) return 'Invoice'
  const header = (JSON.parse(row.json) as SyncChange).payload as {
    issuedAt?: unknown
    clientSyncId?: unknown
    issuedAmountCents?: unknown
    currency?: unknown
  }
  const issued =
    typeof header.issuedAt === 'string' ? ` issued ${instant(header.issuedAt).slice(0, 10)}` : ''
  const client =
    typeof header.clientSyncId === 'string'
      ? ` for ${clientLabel(db, header.clientSyncId, labels)}`
      : ''
  // Amounts stay hidden while presenting, like names.
  const amount =
    !labels.presentation &&
    typeof header.issuedAmountCents === 'number' &&
    typeof header.currency === 'string'
      ? `, ${(header.issuedAmountCents / 100).toFixed(2)} ${header.currency.toUpperCase()}`
      : ''
  return `Invoice${issued}${client}${amount}`
}

/** Shared invoice records that hold billing, from the invoice adapter. Nothing contacts Stripe. */
function invoiceConflicts(db: Reader, workspaceId: string, labels: Labels): HeldConflict[] {
  return invoiceBillingBlockers(db, workspaceId).map((blocker) => {
    const operation =
      blocker.entityType === 'provider-intent'
        ? db
            .select({ kind: providerOperations.kind })
            .from(providerOperations)
            .where(eq(providerOperations.id, blocker.entityId))
            .get()
        : undefined
    return {
      kind: 'held' as const,
      key: `${blocker.entityType}:${blocker.entityId}:${blocker.reason}`,
      title:
        blocker.entityType === 'invoice'
          ? invoiceTitle(db, workspaceId, blocker.entityId, labels)
          : (OPERATION_TITLES[operation?.kind ?? ''] ?? 'A Stripe action'),
      explanation: INVOICE_EXPLANATIONS[blocker.reason]
    }
  })
}

/** Newer record types with a conflict; legacy and invoice types have their own readers above. */
function heldConflicts(db: Reader, workspaceId: string): HeldConflict[] {
  const held: HeldConflict[] = []
  const rows = db
    .select()
    .from(syncRecordStates)
    .where(eq(syncRecordStates.workspaceId, workspaceId))
    .all()
  for (const row of rows) {
    if (KNOWN_TYPES.has(row.entityType) || INVOICE_TYPES.has(row.entityType)) continue
    let state: { conflicts?: unknown; view?: { conflicts?: unknown } }
    try {
      state = JSON.parse(row.stateJson)
    } catch {
      continue
    }
    const count = (value: unknown) => (Array.isArray(value) ? value.length : 0)
    if (count(state?.conflicts) > 0 || count(state?.view?.conflicts) > 0)
      held.push({
        kind: 'held',
        key: `${row.entityType}:${row.entityId}`,
        title: `Shared ${row.entityType.replace(/[^a-z0-9]+/gi, ' ').trim()} record`,
        explanation:
          'This kind of shared record cannot be resolved on this screen. It keeps its last agreed value until it is resolved where it is edited.'
      })
  }
  return held
}

/** Every visible conflict of the connected shared history, read-only. */
export function listSyncConflicts<S extends Record<string, unknown>>(
  db: Db<S>,
  options: { presentation?: boolean } = {}
): SyncConflictReview {
  const workspaceId = directorySyncWorkspace(db)
  if (!workspaceId) return { items: [] }
  const labels = { presentation: !!options.presentation }
  const items: SyncConflictItem[] = []
  const policy = policyConflict(db, workspaceId)
  if (policy) items.push(policy)
  const states = db
    .select({ entityType: syncRecordStates.entityType, entityId: syncRecordStates.entityId })
    .from(syncRecordStates)
    .where(
      and(
        eq(syncRecordStates.workspaceId, workspaceId),
        inArray(syncRecordStates.entityType, ['client', 'project', 'manual-entry'])
      )
    )
    .all()
    .sort((left, right) =>
      left.entityType === right.entityType
        ? left.entityId < right.entityId
          ? -1
          : 1
        : left.entityType < right.entityType
          ? -1
          : 1
    )
  for (const state of states) {
    const conflict = recordConflict(
      db,
      recordView(db, workspaceId, state.entityType as RecordConflict['entityType'], state.entityId),
      labels
    )
    if (conflict) items.push(conflict)
  }
  const splitChoices = new Set(
    items.flatMap((item) => (item.kind === 'record' && item.waiting?.length ? [item.entityId] : []))
  )
  items.push(...manualPartsHeld(db, workspaceId, splitChoices))
  for (const target of mappedConversations(db).values()) {
    const conflict = sessionConflict(db, workspaceId, target, labels)
    if (conflict) items.push(conflict)
  }
  const queue = readLegacyQueue(db, workspaceId)
  const pending = new Map<string, number>()
  for (const entry of queue)
    if (entry.splitFrom && entry.reasons.includes('pending-split'))
      pending.set(entry.splitFrom, (pending.get(entry.splitFrom) ?? 0) + 1)
  const edits = legacyEditConflicts(db, workspaceId, pending, labels)
  items.push(
    ...edits,
    ...legacyConflicts(db, workspaceId, queue),
    ...legacyPartsHeld(
      db,
      workspaceId,
      queue,
      new Set(edits.filter((item) => item.waiting.length).map((item) => item.legacyId))
    ),
    ...invoiceConflicts(db, workspaceId, labels),
    ...heldConflicts(db, workspaceId)
  )
  return { items: disambiguate(items) }
}

// ── Input protection ──

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isJson(value: unknown, depth = 0): value is JsonValue {
  if (depth > 8) return false
  // Echoed values must still equal a shown alternative; this only bounds the payload. Saved
  // descriptions may be longer than what can be typed here.
  if (value === null || typeof value === 'boolean' || typeof value === 'string')
    return typeof value !== 'string' || value.length <= MAX_ECHOED_TEXT
  if (typeof value === 'number') return Number.isFinite(value)
  if (Array.isArray(value))
    return value.length <= MAX_IDS && value.every((item) => isJson(item, depth + 1))
  return (
    isObject(value) &&
    Object.keys(value).length <= 32 &&
    Object.keys(value).every((key) => key !== '__proto__' && isJson(value[key], depth + 1))
  )
}

function text(value: unknown, label: string, max = 400): string {
  if (typeof value !== 'string' || !value || value.length > max) invalid(`${label} is invalid`)
  return value
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const isId = (value: unknown): value is string => typeof value === 'string' && UUID.test(value)

function ids(value: unknown, label: string, check: (item: unknown) => boolean = isId): string[] {
  if (!Array.isArray(value) || value.length > MAX_IDS || !value.every(check))
    invalid(`${label} is invalid`)
  return [...value] as string[]
}

function heads(value: unknown): ConflictHeads {
  if (!isObject(value) || Object.keys(value).length > 32) invalid('Expected heads are invalid')
  return normalHeads(
    Object.fromEntries(
      Object.entries(value).map(([field, list]) => [text(field, 'Field', 64), ids(list, 'Heads')])
    )
  )
}

function only(value: Record<string, unknown>, keys: string[]): void {
  const extra = Object.keys(value).find((key) => !keys.includes(key))
  if (extra) invalid(`Unexpected ${extra}`)
}

function assignment(value: unknown): SessionAssignment {
  if (!isObject(value)) invalid('Choose a client and project')
  only(value, ['clientSyncId', 'projectSyncId'])
  const read = (item: unknown) =>
    item === null ? null : isSyncUuid(item) ? item : invalid('Assignment is invalid')
  return { clientSyncId: read(value.clientSyncId), projectSyncId: read(value.projectSyncId) }
}

function sessionValues(value: unknown): SessionConflictValues {
  if (!isObject(value)) invalid('Values are invalid')
  only(value, ['assignment', 'description', 'billable', 'time'])
  const result: SessionConflictValues = {}
  const { description, billable, time } = value
  if (value.assignment !== undefined) result.assignment = assignment(value.assignment)
  if (description !== undefined) {
    if (description !== null && (typeof description !== 'string' || description.length > MAX_TEXT))
      invalid('Description is invalid')
    result.description = typeof description === 'string' && description.trim() ? description : null
  }
  if (billable !== undefined) {
    if (typeof billable !== 'boolean') invalid('Billable must be yes or no')
    result.billable = billable
  }
  if (time === null) result.time = null
  else if (time !== undefined) {
    if (!isObject(time)) invalid('Corrected time is invalid')
    only(time, ['startedAt', 'endedAt', 'durationMinutes'])
    const corrected: NonNullable<SessionConflictValues['time']> = {}
    for (const field of ['startedAt', 'endedAt'] as const) {
      const given = time[field]
      if (given === undefined) continue
      const at = Date.parse(text(given, 'Time', 40))
      if (!Number.isFinite(at)) invalid('Time is invalid')
      corrected[field] = new Date(at).toISOString()
    }
    const duration = time.durationMinutes
    if (duration !== undefined) {
      if (typeof duration !== 'number' || !Number.isSafeInteger(duration))
        invalid('Duration is invalid')
      corrected.durationMinutes = duration
    }
    result.time = corrected
  }
  return result
}

const PROVIDERS = new Set(Object.keys(PROVIDER_LABELS))
function target(value: Record<string, unknown>): PortableSessionTarget {
  const provider = text(value.provider, 'Provider', 40)
  if (!PROVIDERS.has(provider)) invalid('Provider is invalid')
  return { provider, conversationId: text(value.conversationId, 'Conversation') }
}

const FINGERPRINT = /^[0-9a-f]{64}$/
const fingerprint = (value: unknown) =>
  typeof value === 'string' && FINGERPRINT.test(value) ? value : invalid('Review is invalid')

/** Strict structural check of an untrusted resolution (IPC input). */
export function readSyncConflictResolution(value: unknown): SyncConflictResolution {
  if (!isObject(value)) invalid('Resolution is invalid')
  switch (value.kind) {
    case 'record': {
      only(value, [
        'kind',
        'entityType',
        'entityId',
        'expectedHeads',
        'present',
        'values',
        'disposition'
      ])
      const { entityType, entityId, present, values, disposition } = value
      if (entityType !== 'client' && entityType !== 'project' && entityType !== 'manual-entry')
        invalid('Record type is invalid')
      if (!isId(entityId)) invalid('Record is invalid')
      if (typeof present !== 'boolean') invalid('Choose keep or delete')
      if (!isObject(values) || !isJson(values)) invalid('Values are invalid')
      if (disposition !== undefined && (entityType !== 'manual-entry' || !isJson(disposition)))
        invalid('Choose keep or one of the shown removals')
      return {
        kind: 'record',
        entityType,
        entityId,
        expectedHeads: heads(value.expectedHeads),
        present,
        values: values as Record<string, JsonValue>,
        ...(disposition !== undefined ? { disposition: disposition as JsonValue } : {})
      }
    }
    case 'policy': {
      only(value, ['kind', 'expectedHeads', 'policy'])
      const { policy } = value
      if (!isJson(policy)) invalid('Policy is invalid')
      return { kind: 'policy', expectedHeads: heads(value.expectedHeads), policy }
    }
    case 'session-fragment': {
      only(value, [
        'kind',
        'provider',
        'conversationId',
        'fragmentHash',
        'reviewFingerprint',
        'action',
        'values',
        'acknowledgedCopyEdits'
      ])
      const { action, acknowledgedCopyEdits } = value
      if (action !== 'set' && action !== 'remove-edit') invalid('Action is invalid')
      if (!Array.isArray(acknowledgedCopyEdits) || acknowledgedCopyEdits.length > MAX_IDS)
        invalid('Accepted changes are invalid')
      return {
        kind: 'session-fragment',
        ...target(value),
        fragmentHash: fingerprint(value.fragmentHash),
        reviewFingerprint: fingerprint(value.reviewFingerprint),
        action,
        values: sessionValues(value.values),
        acknowledgedCopyEdits: (acknowledgedCopyEdits as unknown[]).map((item) => {
          if (!isObject(item)) invalid('Accepted changes are invalid')
          only(item, ['entityId', 'source', 'revisions'])
          const { entityId, source } = item
          if (!isId(entityId) || !isId(source)) invalid('Accepted changes are invalid')
          return { entityId, source, revisions: ids(item.revisions, 'Accepted changes') }
        })
      }
    }
    case 'session-mapping':
      only(value, [
        'kind',
        'provider',
        'conversationId',
        'reviewFingerprint',
        'expectedHeads',
        'value'
      ])
      return {
        kind: 'session-mapping',
        ...target(value),
        reviewFingerprint: fingerprint(value.reviewFingerprint),
        expectedHeads: heads(value.expectedHeads),
        value: assignment(value.value)
      }
    case 'session-deletion': {
      only(value, [
        'kind',
        'provider',
        'conversationId',
        'reviewFingerprint',
        'operationId',
        'entityId'
      ])
      const { operationId, entityId } = value
      if (!isId(operationId) || !isId(entityId)) invalid('Deletion is invalid')
      return {
        kind: 'session-deletion',
        ...target(value),
        reviewFingerprint: fingerprint(value.reviewFingerprint),
        operationId,
        entityId
      }
    }
    case 'legacy':
      only(value, [
        'kind',
        'provider',
        'conversationId',
        'reviewFingerprint',
        'candidates',
        'keep',
        'duplicates'
      ])
      return {
        kind: 'legacy',
        ...target(value),
        reviewFingerprint: fingerprint(value.reviewFingerprint),
        candidates: ids(value.candidates, 'Candidates'),
        keep: ids(value.keep, 'Kept history'),
        duplicates: ids(value.duplicates, 'Duplicates')
      }
    case 'legacy-edit': {
      only(value, ['kind', 'legacyId', 'expectedHeads', 'lifecycle', 'values'])
      const { legacyId, lifecycle, values } = value
      if (!isId(legacyId)) invalid('Saved session is invalid')
      if (!isObject(values) || !isJson(values)) invalid('Values are invalid')
      const extra = Object.keys(values).find((field) => !LEGACY_RESOLUTION_FIELDS.has(field))
      if (extra) invalid(`Unexpected ${extra}`)
      let chosen: { present: boolean; disposition: JsonValue } | undefined
      if (lifecycle !== undefined) {
        if (!isObject(lifecycle)) invalid('Choose keep or one of the shown removals')
        only(lifecycle, ['present', 'disposition'])
        if (typeof lifecycle.present !== 'boolean' || !isJson(lifecycle.disposition))
          invalid('Choose keep or one of the shown removals')
        chosen = { present: lifecycle.present, disposition: lifecycle.disposition }
      }
      return {
        kind: 'legacy-edit',
        legacyId,
        expectedHeads: heads(value.expectedHeads),
        ...(chosen ? { lifecycle: chosen } : {}),
        values: values as Record<string, JsonValue>
      }
    }
    default:
      return invalid('Resolution is invalid')
  }
}

// ── Resolution ──

function allowed(state: RecordView['fields'][string], value: JsonValue): boolean {
  return (
    state.heads.some((head) => same(head.value, value)) ||
    (state.value !== undefined && same(state.value, value))
  )
}

function planRecord(
  db: Reader,
  workspaceId: string,
  request: Extract<SyncConflictResolution, { kind: 'record' }>
): RevisionChange {
  const view = recordView(db, workspaceId, request.entityType, request.entityId)
  if (view.lifecycle === 'missing' || !same(normalHeads(view.heads), request.expectedHeads)) stale()
  if (!view.conflicts.length) stale()
  const shown = new Set(recordFields(db, view, { presentation: false }).map((field) => field.field))
  const values: Record<string, JsonValue> = {}
  for (const [field, value] of Object.entries(request.values)) {
    if (!shown.has(field))
      invalid(`${FIELD_LABELS[field] ?? 'That field'} has no conflict to resolve`)
    if (!allowed(view.fields[field], value))
      invalid(`Choose one of the shown values for ${FIELD_LABELS[field] ?? field}`)
    values[field] = value
  }
  if (!request.present && Object.keys(values).length)
    invalid('Deleting does not keep field choices')
  // A manual entry's lifecycle is exactly one shown choice: keep, delete or one recorded split.
  const lifecycle = manualLifecycleChoices(view)
  let disposition: ManualDisposition | undefined
  if (lifecycle) {
    if (request.disposition === undefined) invalid('Choose whether this entry keeps counting')
    const chosen = lifecycle.find(
      (choice) =>
        choice.present === request.present && same(choice.disposition, request.disposition)
    )
    if (!chosen) invalid('Choose one of the shown options')
    if (!chosen.present) disposition = chosen.disposition as unknown as ManualDisposition
  } else if (request.disposition !== undefined) invalid('This entry has no removal to choose')
  else if (!request.present && view.lifecycle !== 'conflict')
    invalid('Only an edited-and-deleted record can be deleted here')
  const action = {
    type: 'resolve' as const,
    expectedHeads: view.heads,
    values,
    present: request.present
  }
  return planning(() =>
    request.entityType === 'manual-entry'
      ? planManualEntryRevision(db, workspaceId, {
          id: randomUUID(),
          entryId: request.entityId,
          action,
          disposition
        })
      : planDirectoryRevision(db, workspaceId, {
          id: randomUUID(),
          entityType: request.entityType as DirectoryEntityType,
          entityId: request.entityId,
          action
        })
  )
}

function checkedConversation(
  db: Reader,
  workspaceId: string,
  request: { provider: string; conversationId: string; reviewFingerprint: string }
): ConversationContext {
  const context = readConversation(db, workspaceId, {
    provider: request.provider,
    conversationId: request.conversationId
  })
  if (sessionFingerprint(workspaceId, db, context) !== request.reviewFingerprint) stale()
  return context
}

function portableValues(
  values: SessionConflictValues,
  hash: string
): Partial<PortableSessionValues> {
  const result: Partial<PortableSessionValues> = {}
  if (values.assignment) {
    result.clientSyncId = values.assignment.clientSyncId
    result.projectSyncId = values.assignment.projectSyncId
  }
  if (values.description !== undefined) result.description = values.description
  if (values.billable !== undefined) result.billable = values.billable
  if (values.time !== undefined)
    result.time = values.time === null ? null : { ...values.time, baseCoverageHash: hash }
  return result
}

function planSession(
  db: Reader,
  workspaceId: string,
  request: Extract<
    SyncConflictResolution,
    { kind: 'session-fragment' | 'session-mapping' | 'session-deletion' }
  >
): RevisionChange[] {
  const context = checkedConversation(db, workspaceId, request)
  if (request.kind === 'session-mapping') {
    const mapping = context.records.mapping
    if (!mapping || !same(normalHeads(mapping.view.heads), request.expectedHeads)) stale()
    return [
      planning(() =>
        planSessionMappingRevision(db, workspaceId, {
          id: randomUUID(),
          target: context.target,
          action: {
            type: 'resolve',
            expectedHeads: mapping.view.heads,
            values: { ...request.value },
            present: true
          }
        })
      )
    ]
  }
  if (request.kind === 'session-deletion') {
    // Only a deletion of this very conversation that the edit did not see; never an undelete.
    const conflict = context.resolution.deletionConflicts.find(
      (item) => item.operationId === request.operationId && item.entityId === request.entityId
    )
    if (!conflict || !context.deletions.some((item) => item.operationId === request.operationId))
      stale()
    const record = context.records.edits.find((item) => item.entityId === request.entityId)!
    const change = planning(() =>
      planRevision({
        id: randomUUID(),
        schema: SESSION_EDIT_SCHEMA,
        entityId: record.entityId,
        history: record.history,
        action:
          record.view.lifecycle === 'conflict'
            ? { type: 'resolve', expectedHeads: record.view.heads, present: false }
            : { type: 'delete', observedHeads: record.view.heads },
        dependencies: [request.operationId]
      })
    )
    planning(() => validateSessionRecordChange(change))
    return [change]
  }
  const index = context.entries.findIndex((entry) => entry.hash === request.fragmentHash)
  if (index < 0) stale()
  const entry = context.entries[index]
  if (!context.resolution.fragments[index].reasons.length) stale()
  if (request.action === 'remove-edit') {
    if (Object.keys(request.values).length || request.acknowledgedCopyEdits.length)
      invalid('Removing the edit does not keep other choices')
    const conflicted = attachedSessionRecords(entry.fragment, context.records.edits).filter(
      (record) => record.view.lifecycle === 'conflict'
    )
    if (!conflicted.length) invalid('This session has no removed edit to confirm')
    return conflicted.map((record) => {
      const change = planning(() =>
        planRevision({
          id: randomUUID(),
          schema: SESSION_EDIT_SCHEMA,
          entityId: record.entityId,
          history: record.history,
          action: { type: 'resolve', expectedHeads: record.view.heads, present: false }
        })
      )
      planning(() => validateSessionRecordChange(change))
      return change
    })
  }
  const values = portableValues(request.values, entry.hash)
  if (!Object.keys(values).length) invalid('Choose or enter at least one value')
  // The planner compares accepted copy edits with the current unobserved revisions exactly.
  return planning(() =>
    planPortableSessionEdit(db, workspaceId, {
      target: context.target,
      fragment: entry.fragment,
      cuts: context.cuts,
      values,
      resolve: true,
      acknowledgedCopyEdits: request.acknowledgedCopyEdits,
      newId: randomUUID
    })
  )
}

function planPolicy(
  db: Reader,
  workspaceId: string,
  request: Extract<SyncConflictResolution, { kind: 'policy' }>
): RevisionChange {
  const view = sharedWorkspacePolicyView(db, workspaceId)
  if (view.lifecycle === 'missing' || !same(normalHeads(view.heads), request.expectedHeads)) stale()
  if (!view.conflicts.length) stale()
  // The whole policy is chosen; timeout and time zone never combine from different edits.
  if (!allowed(view.fields.policy, request.policy))
    invalid('Choose one of the shown tracking policies')
  return planning(() =>
    planWorkspacePolicyRevision(db, workspaceId, randomUUID(), {
      type: 'resolve',
      expectedHeads: view.heads,
      values: { policy: request.policy },
      present: true
    })
  )
}

function planLegacyGroup(
  db: Reader,
  workspaceId: string,
  request: Extract<SyncConflictResolution, { kind: 'legacy' }>
): SyncChange {
  const candidates = [...new Set(request.candidates)].sort()
  const decided = [...request.keep, ...request.duplicates].sort()
  if (!same(candidates, decided) || new Set(decided).size !== decided.length)
    invalid('Choose keep or duplicate for every saved copy')
  // planLegacyReconciliation supersedes every current review of the group, so the group, its
  // reviews and each copy must be exactly what was shown.
  const group = readLegacyGroups(db, workspaceId, request.provider, request.conversationId).find(
    (item) => same(item.candidates, candidates)
  )
  if (
    !group?.needsReview ||
    legacyFingerprint(db, workspaceId, group) !== request.reviewFingerprint
  )
    stale()
  if (!group.activityOverlap && !request.keep.length)
    invalid(
      'Keep at least one copy. No recorded activity covers this time, so marking every copy as a duplicate would drop it from totals.'
    )
  try {
    return planLegacyReconciliation(db, workspaceId, {
      provider: request.provider,
      conversationId: request.conversationId,
      candidates,
      keep: request.keep,
      duplicates: request.duplicates
    })
  } catch (error) {
    if (error instanceof AppError && error.code === 'SYNC_STALE_REVIEW') stale()
    if (error instanceof AppError && error.code === 'SYNC_REFERENCE_UNAVAILABLE')
      throw new AppError(
        error.code,
        'Some of these saved copies are not shared yet. Sync, then review again.'
      )
    if (error instanceof SyncError) invalid(error.message)
    throw error
  }
}

function isSplit(value: unknown): value is Extract<LegacyDisposition, { kind: 'split' }> {
  return (
    typeof value === 'object' && value !== null && (value as { kind?: unknown }).kind === 'split'
  )
}

function planLegacyEdit(
  db: Reader,
  workspaceId: string,
  request: Extract<SyncConflictResolution, { kind: 'legacy-edit' }>
): SyncChange {
  const view = getLegacyEditView(db, workspaceId, request.legacyId)
  if (
    view.lifecycle === 'missing' ||
    !view.conflicts.length ||
    !same(normalHeads(view.heads), request.expectedHeads)
  )
    stale()
  const snapshot = readLegacySnapshot(db, workspaceId, request.legacyId)
  if (!snapshot) stale()
  const lifecycle = legacyLifecycleChoices(view)
  let present: boolean | undefined
  let disposition: LegacyDisposition | undefined
  if (lifecycle) {
    if (!request.lifecycle) invalid('Choose whether this saved session keeps counting')
    const chosen = lifecycle.find(
      (choice) =>
        choice.present === request.lifecycle!.present &&
        same(choice.disposition, request.lifecycle!.disposition)
    )
    if (!chosen) invalid('Choose one of the shown options')
    present = chosen.present
    if (!present) disposition = chosen.disposition as unknown as LegacyDisposition
  } else if (request.lifecycle) invalid('This saved session has no removal to choose')
  else if (view.lifecycle === 'deleted') {
    // Settling a value on an already removed session keeps its agreed removal, never a new one.
    const current = view.fields.disposition?.value
    if (current !== undefined && current !== null)
      disposition = current as unknown as LegacyDisposition
  }

  const shown = legacyEditFields(db, view, snapshot, { presentation: false })
  const values: Partial<LegacyEditValues> = {}
  for (const [field, value] of Object.entries(request.values)) {
    const item = shown.find((candidate) => candidate.field === field)
    if (!item) invalid(`${FIELD_LABELS[field] ?? 'That field'} has no conflict to resolve`)
    if (
      !item.alternatives.some((choice) => same(choice.value, value)) &&
      !(item.lastAgreed && same(item.lastAgreed.value, value))
    )
      invalid(`Choose one of the shown values for ${item.label}`)
    if (field === 'assignment') {
      const pair = value as { clientSyncId: string | null; projectSyncId: string | null }
      values.clientSyncId = pair.clientSyncId
      values.projectSyncId = pair.projectSyncId
    } else (values as Record<string, JsonValue>)[field] = value
  }
  if (!lifecycle && !Object.keys(values).length) invalid('Choose at least one value')
  const result = { ...effectiveLegacyValues(view, snapshot), ...values }
  if (Date.parse(result.endedAt) < Date.parse(result.startedAt))
    invalid('The chosen end is before the chosen start. Choose times that belong together.')

  let change: SyncChange
  try {
    change = planLegacyEditRevision(db, workspaceId, {
      legacyId: request.legacyId,
      disposition,
      action: {
        type: 'resolve',
        expectedHeads: view.heads,
        values: values as unknown as Record<string, JsonValue>,
        ...(present === undefined ? {} : { present })
      }
    }) as unknown as SyncChange
  } catch (error) {
    if (error instanceof AppError && error.code === 'SYNC_INVALID_LEGACY_EDIT')
      return /Stale resolution/.test(error.message) ? stale() : invalid(error.message)
    if (error instanceof AppError && error.code === 'SYNC_REFERENCE_UNAVAILABLE')
      throw new AppError(
        error.code,
        'The chosen client or project is not on this computer yet. Sync, then review again.'
      )
    throw error
  }
  // A kept split must depend on its parts' saved snapshots, as the original split did; the
  // resolve planner does not add them itself.
  const written = (
    change.payload.fields as unknown as Record<string, { value?: unknown }> | undefined
  )?.disposition?.value
  if (isSplit(written)) {
    const parts = written.children.map((child) =>
      syncFactChangeId(workspaceId, 'legacy-session', child)
    )
    change = { ...change, dependencies: [...new Set([...change.dependencies, ...parts])].sort() }
    try {
      validateLegacyEditChange(change)
    } catch (error) {
      if (error instanceof SyncError) invalid(error.message)
      throw error
    }
  }
  return change
}

/** Shared projections after a committed resolution; problems are reported, never auto-resolved. */
function refreshAfterResolution<S extends Record<string, unknown>>(
  db: Db<S>,
  workspaceId: string,
  deviceId: string | undefined
): string[] {
  const followUp: string[] = []
  try {
    const policy = projectSharedWorkspacePolicy(db)
    if (policy.status === 'review-required')
      followUp.push(
        'The shared tracking policy is chosen, but some saved sessions would change under it. They keep their current values until you review the policy change in Tracking settings.'
      )
  } catch (error) {
    if (!(error instanceof AppError)) throw error
    followUp.push(error.message)
  }
  db.transaction(() => {
    resolveLegacyReferences(db, workspaceId)
    refreshLegacyQueue(db, workspaceId)
  })
  const projection = projectSharedSessions(db, workspaceId, { deviceId })
  if (projection.status === 'waiting-policy')
    followUp.push('Shared sessions update after the tracking policy is settled.')
  return followUp
}

/**
 * Applies one explicit resolution. Journals through the domain adapters in a single transaction
 * (rolled back entirely on a stale review), then refreshes shared projections.
 */
export function resolveSyncConflict<S extends Record<string, unknown>>(
  db: Db<S>,
  input: unknown,
  options: { deviceId?: string } = {}
): SyncConflictOutcome {
  const request = readSyncConflictResolution(input)
  const workspaceId = workspaceOf(db)
  // better-sqlite3 runs nested adapter transactions as savepoints of this one connection.
  db.transaction(
    () => {
      switch (request.kind) {
        case 'record': {
          const change = planRecord(db, workspaceId, request)
          if (request.entityType === 'manual-entry')
            journalManualSyncChanges(db, workspaceId, [change])
          else recordLocalSyncChanges(db, workspaceId, [change], directoryRecordsAdapter)
          return
        }
        case 'policy':
          recordLocalSyncChanges(
            db,
            workspaceId,
            [planPolicy(db, workspaceId, request)],
            workspacePolicySyncAdapter
          )
          return
        case 'legacy':
          journalLegacySyncChanges(db, workspaceId, [planLegacyGroup(db, workspaceId, request)])
          return
        case 'legacy-edit':
          journalLegacySyncChanges(db, workspaceId, [planLegacyEdit(db, workspaceId, request)])
          return
        default:
          journalSessionRecordChanges(db, workspaceId, planSession(db, workspaceId, request))
      }
    },
    { behavior: 'immediate' }
  )
  // The choice is committed; a failed refresh must not read as a failed choice.
  try {
    return { followUp: refreshAfterResolution(db, workspaceId, options.deviceId) }
  } catch {
    return {
      followUp: ['Your choice was saved. Some sessions and totals update after the next sync.']
    }
  }
}
