import { createHash, randomUUID } from 'node:crypto'
import { and, eq, inArray } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { AppError } from '../../shared/types/ipc'
import { activityIdentities } from '../db/schema/activity-evidence'
import { sessions, type Session } from '../db/schema/sessions'
import { sessionDerivations, sessionTimeOverrides } from '../db/schema/session-derivations'
import { sessionActivityMappings } from '../db/schema/session-activity-mappings'
import { activeSessionCondition, sessionDeletions } from '../db/schema/session-deletions'
import { sessionBillingRefs } from '../db/schema/session-history'
import {
  sessionMappingDecisions,
  sessionMappingOutcomes,
  sessionMappingRevisions
} from '../db/schema/session-mapping-revisions'
import {
  readCanonicalIntervalSnapshot,
  type CanonicalIntervalCoverage
} from './canonical-intervals'
import {
  PORTABLE_DELETION_PROJECTION_SCOPE,
  isMappingHead,
  isPolicyHoldReleased,
  readCanonicalHistoryProofs,
  readPolicyHolds
} from './canonical-history-proof'
import {
  getWorkspacePolicy,
  isCoverageWithin,
  previewLedgerWorkspacePolicy,
  readCanonicalHistoryConstraints,
  type WorkspacePolicySnapshot
} from './workspace-policy'
import { previewSessionMappingTransitions } from './session-mapping-transitions'
import { coverageHash, derivedUuid, planSessionMappingApplication } from './session-mapping-plan'
import { applySessionMappingApplication } from './session-mapping-application'
import { retainInvoiceBillingRefs } from './session-billing'
import { recordSessionRevision } from './session-history'
import { readPortableHistoryFacts } from './folder-sync-history-records'
import {
  readPortableSessionRecords,
  type PortableTimeOverride
} from './folder-sync-session-records'
import {
  resolvePortableConversation,
  type PortableSessionFragment,
  type PortableSessionResolution
} from './folder-sync-session-overlay'
import { getDirectoryRecordView } from './folder-sync-directory-records'
import { findClientByPortableId, findProjectByPortableId } from './folder-sync-builtin-client'
import { getProjectFolderMapping } from './project-folder-mappings'

/*
 * Imported canonical history becomes local session rows (folder-sync-plan.md decisions B, D, E).
 * Automatic sessions stay derived views: intervals come from the shared ledger, the workspace
 * policy and explicit history facts through the one reviewed mapping transaction
 * (applySessionMappingApplication); portable assignments and edits are overlaid on the result.
 *
 * - A local adopted row whose whole coverage imported deletion facts already remove is retired as
 *   non-counting audit history by a local binding decision naming those facts. It is not a local
 *   deletion proof and is never exported again. Rows only partly deleted retire through the
 *   planner (trimmed predecessors) with a new successor row.
 * - Anything ambiguous (policy holds, unadopted local history, metadata choices, lifecycle or
 *   field conflicts, edit-versus-delete, orphaned anchors, unknown directory references) is held
 *   and reported. Held rows keep their last agreed local values; independent conversations still
 *   progress. Unresolved metadata blocks billing of the affected rows.
 * - Repeating a projection over unchanged facts writes nothing.
 *
 * The caller runs projectSharedWorkspacePolicy first; this never changes the policy.
 */

type Db<S extends Record<string, unknown>> = BetterSQLite3Database<S>
type Mapping = typeof sessionActivityMappings.$inferSelect
type TimeField = 'startedAt' | 'endedAt' | 'durationMinutes'

export interface SessionProjectionIssue {
  /** JSON [provider, conversationId]. */
  conversation: string
  code:
    | 'history-held'
    | 'policy-review-required'
    | 'deletion-waiting'
    | 'deletion-review-required'
    | 'application-failed'
    | 'metadata-held'
    | 'edit-delete-conflict'
    | 'orphaned-session-edit'
    | 'directory-unavailable'
  message: string
  sessionIds: number[]
  records?: string[]
  operationIds?: string[]
  reasons?: string[]
}

export interface SessionProjectionBillingBlocker {
  conversation: string
  sessionIds: number[]
  code: string
  detail?: unknown
}

export interface SharedSessionProjection {
  status: 'waiting-policy' | 'projected'
  /** Reviewed mapping decisions written by this projection. */
  applied: Array<{
    conversation: string
    decisionId: string
    sessionIds: number[]
    retiredSessionIds: number[]
  }>
  /** Local rows retired because imported deletion facts remove all of their coverage. */
  deleted: Array<{
    conversation: string
    sessionId: number
    decisionId: string
    operationIds: string[]
    billed: boolean
  }>
  /** Rows whose assignment, description, billable flag or time was set from agreed records. */
  updated: number[]
  held: Array<{ conversation: string; reasons: string[]; sessionIds: number[] }>
  issues: SessionProjectionIssue[]
  billingBlockers: SessionProjectionBillingBlocker[]
}

const keyOf = (provider: string, conversationId: string) =>
  JSON.stringify([provider, conversationId])

function counted(coverage: CanonicalIntervalCoverage): string[] {
  return [
    ...coverage.messages.map((item) => item.eventId),
    ...coverage.continuity.flatMap((edge) => edge.progress.map((item) => item.eventId)),
    ...(coverage.usage ?? []).map((entry) => entry.checkpointId)
  ]
}

/**
 * Active (counting) adopted rows with their mapping heads, grouped by conversation.
 * `scope` reads only those conversations' mappings.
 */
function activeMappedRows<S extends Record<string, unknown>>(tx: Db<S>, scope?: readonly string[]) {
  const keys = scope && new Set(scope)
  const mappings = keys
    ? keys.size
      ? tx
          .select()
          .from(sessionActivityMappings)
          .where(
            inArray(sessionActivityMappings.conversationId, [
              ...new Set([...keys].map((key) => (JSON.parse(key) as [string, string])[1]))
            ])
          )
          .all()
          .filter((row) => keys.has(keyOf(row.provider, row.conversationId)))
      : []
    : tx.select().from(sessionActivityMappings).all()
  const rows = mappings.length
    ? tx
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
  const groups = new Map<string, Array<{ row: Session; mapping: Mapping }>>()
  for (const mapping of mappings) {
    const row = byId.get(mapping.sessionId)
    if (!row) continue
    const key = keyOf(mapping.provider, mapping.conversationId)
    groups.set(key, [...(groups.get(key) ?? []), { row, mapping }])
  }
  return groups
}

/** Policy-changing decisions at the current revision that still hold this conversation. */
function unreleasedPolicyHolds<S extends Record<string, unknown>>(
  tx: Db<S>,
  policy: WorkspacePolicySnapshot,
  key: string,
  active: Array<{ row: Session; mapping: Mapping }>
): string[] {
  const saved = new Set(active.map(({ row }) => `saved:${row.id}`))
  const holds = readPolicyHolds(tx, policy.revisionId)
  let proofs: ReturnType<typeof readCanonicalHistoryProofs> | undefined
  return holds
    .filter((hold) => {
      if (!hold.held) return true
      if (hold.held.some((item) => saved.has(item))) return true
      if (!hold.held.includes(key)) return false
      if (!active.length && !proofs) proofs = readCanonicalHistoryProofs(tx, [key])
      return !isPolicyHoldReleased(
        tx,
        hold.id,
        policy.revisionId,
        active.map(({ mapping }) => mapping.revisionId),
        proofs?.get(key)
      )
    })
    .map((hold) => hold.id)
}

function isBilled<S extends Record<string, unknown>>(tx: Db<S>, sessionId: number): boolean {
  return !!tx
    .select({ id: sessionBillingRefs.sessionId })
    .from(sessionBillingRefs)
    .where(eq(sessionBillingRefs.sessionId, sessionId))
    .get()
}

/**
 * Phase 1: bind local rows wholly removed by imported deletion facts to those facts. Rows whose
 * facts still wait for evidence, were measured under another policy, or are held by a policy
 * decision are reported and left counting until that is resolved.
 */
function projectPortableDeletions<S extends Record<string, unknown>>(
  tx: Db<S>,
  policy: WorkspacePolicySnapshot,
  result: SharedSessionProjection,
  scope: readonly string[] | undefined
): void {
  const facts = readPortableHistoryFacts(tx, scope)
  const groups = activeMappedRows(tx, scope)
  for (const [key, entry] of facts) {
    const active = groups.get(key) ?? []
    if (!entry.deletions.length || !active.length) continue
    const ledger = previewLedgerWorkspacePolicy(tx, policy.policy, [key]).conversations.find(
      (row) => keyOf(row.provider, row.conversationId) === key
    )
    const waiting = new Set(
      ledger?.status === 'resolved'
        ? (ledger.operations?.heldOperations ?? []).map((row) => row.operationId)
        : entry.deletions.map((row) => row.operationId)
    )
    for (const { row, mapping } of active) {
      const interval = readCanonicalIntervalSnapshot(mapping.intervalJson, mapping.provider)
      if (!interval) continue
      const mine = new Set(counted(interval.coverage))
      const overlapping = entry.deletions.filter((fact) =>
        counted(fact.coverage).some((id) => mine.has(id))
      )
      if (!overlapping.length) continue
      const issue = (code: SessionProjectionIssue['code'], message: string) =>
        result.issues.push({
          conversation: key,
          code,
          message,
          sessionIds: [row.id],
          operationIds: overlapping.map((fact) => fact.operationId)
        })
      if (overlapping.some((fact) => waiting.has(fact.operationId))) {
        issue(
          'deletion-waiting',
          'A shared deletion is waiting for the activity it deletes; this session still counts until that activity arrives.'
        )
        continue
      }
      // Partly deleted rows retire through the planner with a successor for the remainder.
      if (
        !isCoverageWithin(
          interval.coverage,
          overlapping.map((fact) => fact.coverage)
        )
      )
        continue
      const head = mapping.revisionId
        ? tx
            .select()
            .from(sessionMappingRevisions)
            .where(eq(sessionMappingRevisions.id, mapping.revisionId))
            .get()
        : undefined
      if (
        !isMappingHead(mapping, head) ||
        row.source !== 'auto' ||
        row.status !== 'completed' ||
        row.tool !== mapping.provider ||
        row.claudeSessionId !== mapping.conversationId ||
        mapping.policyRevisionId !== policy.revisionId ||
        mapping.policyJson !== JSON.stringify(policy.policy)
      ) {
        issue(
          'deletion-review-required',
          'This session was deleted on another computer, but its saved activity needs history review before the deletion can apply here.'
        )
        continue
      }
      if (unreleasedPolicyHolds(tx, policy, key, active).length) {
        issue(
          'policy-review-required',
          'This session was deleted on another computer; review the pending tracking policy change first.'
        )
        continue
      }
      const operationIds = overlapping.map((fact) => fact.operationId).sort()
      const decisionId = derivedUuid(
        'session-history-portable-deletion:v1',
        operationIds.join('\0'),
        `${mapping.id}\0${mapping.revisionId}`
      )
      const hash = coverageHash(mapping.provider, mapping.conversationId, interval.coverage)
      try {
        tx.transaction((inner) => {
          const now = new Date().toISOString()
          retainInvoiceBillingRefs(inner)
          inner
            .insert(sessionMappingDecisions)
            .values({
              id: decisionId,
              requestJson: JSON.stringify({
                decisionId,
                operation: 'project-portable-deletion',
                sessionId: row.id,
                portableOperationIds: operationIds
              }),
              previewFingerprint: `portable-deletion-projection:v1:${createHash('sha256')
                .update(JSON.stringify([key, hash, operationIds]))
                .digest('hex')}`,
              basePolicyRevisionId: policy.revisionId,
              targetPolicyRevisionId: policy.revisionId,
              baseHeadsJson: JSON.stringify(
                active.map((item) => [item.mapping.id, item.mapping.revisionId])
              ),
              planJson: JSON.stringify({
                version: 1,
                scope: PORTABLE_DELETION_PROJECTION_SCOPE,
                sessionId: row.id,
                mappingId: mapping.id,
                mappingRevisionId: mapping.revisionId,
                coverageHash: hash,
                portableOperationIds: operationIds
              }),
              heldJson: '[]',
              observedDecisionIdsJson: '[]',
              createdAt: now
            })
            .run()
          inner
            .insert(sessionDeletions)
            .values({
              id: randomUUID(),
              sessionId: row.id,
              sourceFile: row.sourceFile,
              tool: row.tool,
              claudeSessionId: row.claudeSessionId,
              startedAt: interval.startedAt,
              endedAt: interval.endedAt,
              createdAt: now,
              legacyRecordId: null
            })
            .run()
          inner
            .insert(sessionMappingOutcomes)
            .values({
              decisionId,
              resultJson: JSON.stringify({
                decisionId,
                operation: 'project-portable-deletion',
                policyRevisionId: policy.revisionId,
                appliedSessionIds: [],
                retiredSessionIds: [row.id],
                held: []
              }),
              createdAt: now
            })
            .run()
          // The binding must read back as a mask of this row, never as an invalid operation.
          const constraints = readCanonicalHistoryConstraints(inner, [key]).get(key)
          if (
            !constraints?.masks.some((mask) => mask.sessionId === row.id) ||
            constraints.invalid.some((hold) => hold.sessionId === row.id)
          )
            throw new AppError('HISTORY_OPERATION_UNVERIFIED', 'Deletion binding did not verify')
        })
      } catch (error) {
        if (!(error instanceof AppError)) throw error
        issue('deletion-review-required', error.message)
        continue
      }
      result.deleted.push({
        conversation: key,
        sessionId: row.id,
        decisionId,
        operationIds,
        billed: isBilled(tx, row.id)
      })
    }
  }
}

/**
 * Phase 2: recalculated intervals through the reviewed mapping transaction, one conversation at
 * a time so a held or failing group never blocks another. No choices or acknowledgments are
 * made on the user's behalf.
 */
function applyProjectedIntervals<S extends Record<string, unknown>>(
  tx: Db<S>,
  policy: WorkspacePolicySnapshot,
  result: SharedSessionProjection,
  scope: readonly string[] | undefined
): void {
  const plan = planSessionMappingApplication(
    previewSessionMappingTransitions(tx, policy.policy, scope),
    randomUUID()
  )
  const groups = activeMappedRows(tx, scope)
  for (const conversation of plan.conversations) {
    const key = keyOf(conversation.provider, conversation.conversationId)
    if (conversation.status === 'held') {
      result.held.push({
        conversation: key,
        reasons: conversation.heldReasons,
        sessionIds: conversation.activeSessionIds
      })
      continue
    }
    const changed =
      conversation.retiredSessionIds.length > 0 ||
      conversation.successors.some(
        (row) => row.kind !== 'continue' || row.keepSessionId === null || !row.intervalUnchanged
      )
    if (!changed) continue
    const holds = unreleasedPolicyHolds(tx, policy, key, groups.get(key) ?? [])
    if (holds.length) {
      result.held.push({
        conversation: key,
        reasons: ['policy-review-required'],
        sessionIds: conversation.activeSessionIds
      })
      result.issues.push({
        conversation: key,
        code: 'policy-review-required',
        message:
          'A reviewed tracking policy change holds this conversation; shared activity was not applied.',
        sessionIds: conversation.activeSessionIds
      })
      continue
    }
    try {
      const scoped = previewSessionMappingTransitions(tx, policy.policy, [key])
      const decisionId = randomUUID()
      const current = planSessionMappingApplication(scoped, decisionId).conversations.find(
        (row) => keyOf(row.provider, row.conversationId) === key
      )
      if (current?.status !== 'applicable') {
        result.held.push({
          conversation: key,
          reasons: current?.heldReasons ?? ['unresolved-activity'],
          sessionIds: conversation.activeSessionIds
        })
        continue
      }
      const outcome = applySessionMappingApplication(tx, {
        decisionId,
        candidate: policy.policy,
        expectedFingerprint: scoped.fingerprint,
        choices: [],
        acknowledgedHeld: [],
        conversationKeys: [key]
      })
      result.applied.push({
        conversation: key,
        decisionId,
        sessionIds: outcome.appliedSessionIds,
        retiredSessionIds: outcome.retiredSessionIds
      })
    } catch (error) {
      if (!(error instanceof AppError)) throw error
      result.issues.push({
        conversation: key,
        code: 'application-failed',
        message: error.message,
        sessionIds: conversation.activeSessionIds
      })
    }
  }
}

const TIME_FIELDS: readonly TimeField[] = ['startedAt', 'endedAt', 'durationMinutes']

/**
 * Phase 3: agreed portable metadata onto the active rows. A field is written only when its
 * value resolves and is agreed (an attached record, or the conversation's mapping); a held
 * field keeps the row's last agreed value. Rows without any portable record are untouched.
 */
function overlayPortableMetadata<S extends Record<string, unknown>>(
  tx: Db<S>,
  workspaceId: string,
  result: SharedSessionProjection,
  deviceId: string | undefined,
  scope: readonly string[] | undefined
): void {
  const facts = readPortableHistoryFacts(tx, scope)
  for (const [key, active] of activeMappedRows(tx, scope)) {
    const [provider, conversationId] = JSON.parse(key) as [string, string]
    const records = readPortableSessionRecords(tx, workspaceId, { provider, conversationId })
    const deletions = facts.get(key)?.deletions ?? []
    if (!records.mapping && !records.edits.length) continue
    const entries = active.flatMap(({ row, mapping }) => {
      const interval = readCanonicalIntervalSnapshot(mapping.intervalJson, mapping.provider)
      return interval ? [{ row, interval }] : []
    })
    const resolved = resolvePortableConversation({
      target: records.target,
      mapping: records.mapping,
      edits: records.edits,
      fragments: entries.map(({ interval }) => ({
        startedAt: interval.startedAt,
        coverage: interval.coverage
      })) satisfies PortableSessionFragment[],
      deletions,
      directory: (entityType, syncId) => getDirectoryRecordView(tx, workspaceId, entityType, syncId)
    })
    const allIds = entries.map(({ row }) => row.id)
    if (resolved.orphaned.length)
      result.issues.push({
        conversation: key,
        code: 'orphaned-session-edit',
        message: 'Shared session edits refer to activity or cuts this computer cannot place yet.',
        sessionIds: [],
        records: resolved.orphaned
      })
    for (const conflict of resolved.deletionConflicts) {
      result.issues.push({
        conversation: key,
        code: 'edit-delete-conflict',
        message:
          'A session was edited on one computer while it was deleted on another. The deletion stays in effect until the conflict is resolved.',
        sessionIds: [],
        records: [conflict.entityId],
        operationIds: [conflict.operationId]
      })
      result.billingBlockers.push({
        conversation: key,
        sessionIds: allIds,
        code: 'edit-delete-conflict',
        detail: conflict
      })
    }
    entries.forEach(({ row }, index) => {
      const resolution = resolved.fragments[index]
      if (resolution.reasons.length) {
        result.issues.push({
          conversation: key,
          code: 'metadata-held',
          message: 'Shared session edits need a choice; the last agreed values are shown.',
          sessionIds: [row.id],
          records: resolution.attached,
          reasons: [...new Set(resolution.reasons.map((reason) => reason.code))].sort()
        })
        result.billingBlockers.push({
          conversation: key,
          sessionIds: [row.id],
          code: 'metadata-held',
          detail: resolution.reasons
        })
      }
      for (const blocker of resolution.billingBlockers)
        result.billingBlockers.push({
          conversation: key,
          sessionIds: [row.id],
          code: blocker.code,
          detail: blocker
        })
      if (projectRowValues(tx, row, resolution, key, result, deviceId)) result.updated.push(row.id)
    })
  }
}

function projectRowValues<S extends Record<string, unknown>>(
  tx: Db<S>,
  row: Session,
  resolution: PortableSessionResolution,
  key: string,
  result: SharedSessionProjection,
  deviceId: string | undefined
): boolean {
  // Unattached fragments only take values the conversation's mapping agreed, never defaults.
  const agreed = (field: keyof PortableSessionResolution['fields']) => {
    const state = resolution.fields[field]
    return state.status === 'resolved' &&
      (resolution.attached.length > 0 || state.source !== 'default')
      ? state
      : null
  }
  const next: Partial<Session> = {}
  const unavailable = (entityType: 'client' | 'project', syncId: string) => {
    result.issues.push({
      conversation: key,
      code: 'directory-unavailable',
      message: `The shared ${entityType} for this session is not available on this computer yet.`,
      sessionIds: [row.id],
      records: [syncId]
    })
    result.billingBlockers.push({
      conversation: key,
      sessionIds: [row.id],
      code: 'directory-unavailable',
      detail: { entityType, entityId: syncId }
    })
  }
  const client = agreed('clientSyncId')
  if (client) {
    if (client.value === null) next.clientId = null
    else {
      const found = findClientByPortableId(tx, client.value as string)
      if (found) next.clientId = found.id
      else unavailable('client', client.value as string)
    }
  }
  const project = agreed('projectSyncId')
  if (project) {
    if (project.value === null) next.projectId = null
    else {
      const found = findProjectByPortableId(tx, project.value as string)
      if (found) next.projectId = found.id
      else unavailable('project', project.value as string)
    }
    // A changed project uses this computer's own folder for it, never another's path.
    if (next.projectId !== undefined && next.projectId !== row.projectId)
      next.projectPath =
        (next.projectId !== null && deviceId
          ? getProjectFolderMapping(
              tx,
              deviceId,
              findProjectByPortableId(tx, project.value as string)!.syncId
            )?.directoryPath
          : undefined) ?? ''
  }
  const description = agreed('description')
  if (description) next.description = description.value as string | null
  const billable = agreed('billable')
  if (billable) next.billable = billable.value ? 1 : 0

  const time = agreed('time')
  let flags: Record<TimeField, 0 | 1> | null = null
  if (time && row.status === 'completed') {
    const baseline = tx
      .select()
      .from(sessionDerivations)
      .where(eq(sessionDerivations.sessionId, row.id))
      .get()
    const override = time.value as unknown as PortableTimeOverride | null
    if (baseline) {
      flags = { startedAt: 0, endedAt: 0, durationMinutes: 0 }
      for (const field of TIME_FIELDS) {
        const value = override?.[field]
        if (value !== undefined) flags[field] = 1
        ;(next as Record<TimeField, unknown>)[field] = value ?? baseline[field]
      }
    }
  }

  const same = (field: keyof Session) => {
    const before = row[field]
    const after = next[field]
    if (field === 'startedAt' || field === 'endedAt')
      return Date.parse(before as string) === Date.parse(after as string)
    return before === after
  }
  const changed = (Object.keys(next) as Array<keyof Session>).filter((field) => !same(field))
  const savedFlags = tx
    .select()
    .from(sessionTimeOverrides)
    .where(eq(sessionTimeOverrides.sessionId, row.id))
    .get()
  const flagsChanged =
    !!flags && TIME_FIELDS.some((field) => (savedFlags?.[field] ?? 0) !== flags![field])
  if (!changed.length && !flagsChanged) return false
  const values = Object.fromEntries(
    changed.map((field) => [field, next[field]])
  ) as Partial<Session>
  if (changed.length) {
    const updatedAt = new Date().toISOString()
    tx.update(sessions)
      .set({ ...values, updatedAt })
      .where(eq(sessions.id, row.id))
      .run()
    const after = tx.select().from(sessions).where(eq(sessions.id, row.id)).get()!
    recordSessionRevision(tx, row, 'edit', row, after)
  }
  if (flagsChanged)
    tx.insert(sessionTimeOverrides)
      .values({ sessionId: row.id, ...flags! })
      .onConflictDoUpdate({ target: sessionTimeOverrides.sessionId, set: flags! })
      .run()
  return true
}

/**
 * Project the imported shared history of `workspaceId` into local session rows. Runs in one
 * immediate transaction; each conversation's writes are isolated, so held groups never block
 * others. Call after importing batches and after projectSharedWorkspacePolicy.
 *
 * `conversationKeys` (distinct JSON [provider, conversationId]) projects only those
 * conversations: facts, mappings, transitions and records of others are not read, and the
 * result reports only them. Callers may commit and yield between scoped calls; iterate
 * sharedSessionConversationKeys to cover what an unscoped call would.
 */
export function projectSharedSessions<S extends Record<string, unknown>>(
  db: Db<S>,
  workspaceId: string,
  options: { deviceId?: string; conversationKeys?: readonly string[] } = {}
): SharedSessionProjection {
  const scope = options.conversationKeys
  return db.transaction(
    (tx) => {
      const result: SharedSessionProjection = {
        status: 'projected',
        applied: [],
        deleted: [],
        updated: [],
        held: [],
        issues: [],
        billingBlockers: []
      }
      const policy = getWorkspacePolicy(tx)
      if (!policy) return { ...result, status: 'waiting-policy' }
      projectPortableDeletions(tx, policy, result, scope)
      applyProjectedIntervals(tx, policy, result, scope)
      overlayPortableMetadata(tx, workspaceId, result, options.deviceId, scope)
      return result
    },
    { behavior: 'immediate' }
  )
}

/**
 * Every conversation an unscoped projectSharedSessions can touch: captured or imported
 * activity, adopted mappings and portable split/deletion facts. Sorted JSON keys.
 */
export function sharedSessionConversationKeys<S extends Record<string, unknown>>(
  db: Db<S>
): string[] {
  const keys = new Set(readPortableHistoryFacts(db).keys())
  for (const row of db
    .selectDistinct({
      provider: activityIdentities.provider,
      conversationId: activityIdentities.conversationId
    })
    .from(activityIdentities)
    .all())
    keys.add(keyOf(row.provider, row.conversationId))
  for (const row of db
    .selectDistinct({
      provider: sessionActivityMappings.provider,
      conversationId: sessionActivityMappings.conversationId
    })
    .from(sessionActivityMappings)
    .all())
    keys.add(keyOf(row.provider, row.conversationId))
  return [...keys].sort()
}
