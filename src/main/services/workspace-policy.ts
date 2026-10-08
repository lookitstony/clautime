import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { workspacePolicy } from '../db/schema/workspace-policy'
import { workspacePolicyRevisions } from '../db/schema/session-mapping-revisions'
import type { sessionSplits } from '../db/schema/session-history'
import type { sessionDeletions } from '../db/schema/session-deletions'
import { appSettings } from '../db/schema/app-settings'
import { AppError } from '../../shared/types/ipc'
import {
  INITIAL_NORMALIZATION_VERSION,
  readTrackingPolicy,
  type TrackingPolicy
} from '../../shared/tracking-policy'
import type { ParsedSessionData } from '../parsers/types'
import { detectSessionsWithPolicy } from './session-detector'
import { readCanonicalActivity, type CanonicalConversation } from './canonical-activity'
import {
  calculateCanonicalIntervals,
  canonicalUsageKey,
  constrainCanonicalIntervals,
  relateCanonicalIntervals,
  type CanonicalHistoryConstraints,
  type CanonicalIntervalCoverage,
  type ConstrainedFragment
} from './canonical-intervals'
import { readCanonicalHistoryProofs } from './canonical-history-proof'
import { readPortableHistoryFacts } from './folder-sync-history-records'

export interface WorkspacePolicySnapshot {
  readonly workspaceId: string
  readonly revisionId: string
  readonly policy: Readonly<TrackingPolicy>
}

function readSnapshot(value: unknown): WorkspacePolicySnapshot {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AppError('INVALID_WORKSPACE_POLICY', 'A workspace policy snapshot is required')
  }
  const snapshot = value as Record<string, unknown>
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
  if (
    typeof snapshot.workspaceId !== 'string' ||
    !uuid.test(snapshot.workspaceId) ||
    typeof snapshot.revisionId !== 'string' ||
    !uuid.test(snapshot.revisionId) ||
    Object.keys(snapshot).some((key) => !['workspaceId', 'revisionId', 'policy'].includes(key))
  ) {
    throw new AppError(
      'INVALID_WORKSPACE_POLICY',
      'A supported snapshot with canonical UUIDs is required'
    )
  }
  return Object.freeze({
    workspaceId: snapshot.workspaceId,
    revisionId: snapshot.revisionId,
    policy: readTrackingPolicy(snapshot.policy)
  })
}

/** Missing is distinct from invalid/incompatible. Never substitute local defaults here. */
export function getWorkspacePolicy<TSchema extends Record<string, unknown>>(
  db: Pick<BetterSQLite3Database<TSchema>, 'select'>
): WorkspacePolicySnapshot | null {
  const row = db.select().from(workspacePolicy).where(eq(workspacePolicy.slot, 1)).get()
  if (!row) return null
  let policy: unknown
  try {
    policy = JSON.parse(row.policyJson)
  } catch {
    throw new AppError('INVALID_WORKSPACE_POLICY', 'Saved workspace policy is not valid JSON')
  }
  return readSnapshot({ workspaceId: row.workspaceId, revisionId: row.revisionId, policy })
}

/** Explicit creation only; retries use the saved policy even if local settings changed. */
export function initializeWorkspacePolicy<TSchema extends Record<string, unknown>>(
  db: BetterSQLite3Database<TSchema>,
  reportingTimeZone: string
): WorkspacePolicySnapshot {
  return db.transaction(
    (tx) => {
      const saved = getWorkspacePolicy(tx)
      if (saved) return saved
      const setting = tx
        .select()
        .from(appSettings)
        .where(eq(appSettings.key, 'idle_timeout_minutes'))
        .get()
      // Avoid interpreting malformed stored text differently from the scanner's parseInt.
      if (setting && !/^[0-9]+$/.test(setting.value)) {
        throw new AppError(
          'INVALID_TRACKING_POLICY',
          'Correct the local idle timeout before creating a workspace'
        )
      }
      const policy = readTrackingPolicy({
        version: 1,
        // Existing workspaces keep the version they recorded; see TrackingPolicy.
        normalizationVersion: INITIAL_NORMALIZATION_VERSION,
        detectorVersion: 1,
        // Matches the local scanner default only when the setting is absent.
        idleTimeoutMinutes: setting ? Number(setting.value) : 15,
        reportingTimeZone
      })
      const snapshot = { workspaceId: randomUUID(), revisionId: randomUUID(), policy }
      tx.insert(workspacePolicyRevisions)
        .values({
          id: snapshot.revisionId,
          workspaceId: snapshot.workspaceId,
          policyJson: JSON.stringify(policy),
          createdAt: new Date().toISOString()
        })
        .run()
      tx.insert(workspacePolicy)
        .values({
          slot: 1,
          workspaceId: snapshot.workspaceId,
          revisionId: snapshot.revisionId,
          policyJson: JSON.stringify(policy)
        })
        .run()
      return Object.freeze(snapshot)
    },
    { behavior: 'immediate' }
  )
}

/** Bootstrap only. This cannot replace an existing workspace or apply a policy change. */
export function adoptInitialWorkspacePolicy<TSchema extends Record<string, unknown>>(
  db: BetterSQLite3Database<TSchema>,
  value: unknown
): WorkspacePolicySnapshot {
  const incoming = readSnapshot(value)
  return db.transaction(
    (tx) => {
      const saved = getWorkspacePolicy(tx)
      if (saved) {
        if (JSON.stringify(saved) !== JSON.stringify(incoming)) {
          throw new AppError(
            'WORKSPACE_POLICY_CONFLICT',
            'Saved workspace policy requires explicit reconciliation'
          )
        }
        return saved
      }
      tx.insert(workspacePolicyRevisions)
        .values({
          id: incoming.revisionId,
          workspaceId: incoming.workspaceId,
          policyJson: JSON.stringify(incoming.policy),
          createdAt: new Date().toISOString()
        })
        .run()
      tx.insert(workspacePolicy)
        .values({
          slot: 1,
          workspaceId: incoming.workspaceId,
          revisionId: incoming.revisionId,
          policyJson: JSON.stringify(incoming.policy)
        })
        .run()
      return incoming
    },
    { behavior: 'immediate' }
  )
}

/** Calculation preview for supplied facts only; never an approval to rewrite saved history. */
export function previewWorkspacePolicy<TSchema extends Record<string, unknown>>(
  db: BetterSQLite3Database<TSchema>,
  recordings: ParsedSessionData[],
  candidate: unknown
) {
  const current = getWorkspacePolicy(db)
  if (!current)
    throw new AppError('WORKSPACE_POLICY_REQUIRED', 'Initialize or join a workspace first')
  const policy = readTrackingPolicy(candidate)
  return {
    scope: 'supplied-recordings' as const,
    workspaceId: current.workspaceId,
    baseRevisionId: current.revisionId,
    currentPolicy: current.policy,
    candidatePolicy: policy,
    before: detectSessionsWithPolicy(recordings, current.policy),
    after: detectSessionsWithPolicy(recordings, policy)
  }
}

type MappedIds = { has(sessionId: number): boolean }
type ResolvedConversation = Extract<CanonicalConversation, { status: 'resolved' }>
type SplitRow = typeof sessionSplits.$inferSelect
type DeletionRow = typeof sessionDeletions.$inferSelect

/** A split of an adopted row whose parts were adopted by the same reviewed operation. */
export function isMappedHistorySplit(split: SplitRow, mapped: MappedIds): boolean {
  return (
    !split.legacyRecordId &&
    mapped.has(split.parentSessionId) &&
    mapped.has(split.firstSessionId) &&
    mapped.has(split.secondSessionId)
  )
}
/** A deletion of an adopted row: its adopted coverage, not its saved times, is removed. */
export function isMappedHistoryDeletion(deletion: DeletionRow, mapped: MappedIds): boolean {
  return !deletion.legacyRecordId && mapped.has(deletion.sessionId)
}

/**
 * Every counted event, usage checkpoint and measured gap instant of `inner` is owned by one of
 * `outers` (the same canonical references; gap spans by the same edge endpoints). Used to bind
 * a local row to deletion facts that already remove all of its coverage.
 */
export function isCoverageWithin(
  inner: CanonicalIntervalCoverage,
  outers: readonly CanonicalIntervalCoverage[]
): boolean {
  const ref = (item: { eventId: string; kind: string; timestamp: string }) =>
    JSON.stringify([item.eventId, item.kind, item.timestamp])
  const counted = (coverage: CanonicalIntervalCoverage) => [
    ...coverage.messages,
    ...coverage.continuity.flatMap((edge) => edge.progress)
  ]
  const events = new Set(outers.flatMap(counted).map(ref))
  const usage = new Set(outers.flatMap((coverage) => (coverage.usage ?? []).map(canonicalUsageKey)))
  const edges = outers.flatMap((coverage) => coverage.continuity)
  return (
    counted(inner).every((item) => events.has(ref(item))) &&
    (inner.usage ?? []).every((entry) => usage.has(canonicalUsageKey(entry))) &&
    inner.continuity.every((edge) => {
      const spans = edges
        .filter(
          (outer) =>
            outer.from.eventId === edge.from.eventId && outer.to.eventId === edge.to.eventId
        )
        .map((outer) => [Date.parse(outer.startedAt), Date.parse(outer.endedAt)])
        .sort((a, b) => a[0] - b[0])
      let covered = Date.parse(edge.startedAt)
      for (const [start, stop] of spans) {
        if (start > covered) break
        covered = Math.max(covered, stop)
      }
      return covered >= Date.parse(edge.endedAt)
    })
  )
}

/**
 * Explicit history operations, per conversation key: the union of (a) splits and deletions of
 * local adopted rows, each proven against the decision, receipt and revisions that created it
 * (see readCanonicalHistoryProofs), and (b) portable split/deletion facts recorded in
 * sync_changes (see readPortableHistoryFacts). Cuts union by normalized instant; a local
 * deletion and its own journaled fact mask the same coverage under both owners. Legacy/manual
 * operations are not constraints; their existing protections still hold those conversations.
 * Unreadable or unproven operations are reported, never skipped, so callers hold instead of
 * counting deleted work again.
 */
export function readCanonicalHistoryConstraints<TSchema extends Record<string, unknown>>(
  db: Pick<BetterSQLite3Database<TSchema>, 'select'>,
  conversationKeys?: readonly string[]
): Map<string, CanonicalHistoryConstraints> {
  const result = new Map<string, CanonicalHistoryConstraints>()
  const entry = (key: string) => {
    const value = result.get(key) ?? { cuts: [], cutOperations: [], masks: [], invalid: [] }
    result.set(key, value)
    return value
  }
  const portable = readPortableHistoryFacts(db, conversationKeys)
  for (const [key, proofs] of readCanonicalHistoryProofs(db, conversationKeys)) {
    const target = entry(key)
    target.cuts.push(...proofs.cuts.map((row) => row.splitAt))
    target.masks.push(
      ...proofs.deletions.map((row) => ({ sessionId: row.sessionId, coverage: row.coverage }))
    )
    target.invalid.push(...proofs.invalid)
    // A projected deletion stands only while the facts it names still read back and cover it.
    for (const row of proofs.projected ?? []) {
      const facts = portable.get(key)?.deletions ?? []
      const bound = row.portableOperationIds.map((id) =>
        facts.find((fact) => fact.operationId === id)
      )
      if (
        bound.every((fact) => !!fact) &&
        isCoverageWithin(
          row.coverage,
          bound.map((fact) => fact!.coverage)
        )
      )
        target.masks.push({ sessionId: row.sessionId, coverage: row.coverage })
      else target.invalid.push({ sessionId: row.sessionId, reason: 'invalid-deleted-coverage' })
    }
  }
  for (const [key, facts] of portable) {
    const target = entry(key)
    target.cuts.push(...facts.cuts.map((row) => row.splitAt))
    target.cutOperations!.push(...facts.cuts)
    target.masks.push(
      ...facts.deletions.map((row) => ({ operationId: row.operationId, coverage: row.coverage }))
    )
    target.invalid.push(...facts.invalid)
  }
  for (const value of result.values()) value.cuts = [...new Set(value.cuts)].sort()
  return result
}

// Coverage lets the planner account for saved coverage a deletion fact already removed.
const fragmentBounds = ({ sessionIds, operationIds, interval }: ConstrainedFragment) => ({
  sessionIds,
  operationIds,
  startedAt: interval.startedAt,
  endedAt: interval.endedAt,
  durationMinutes: interval.durationMinutes,
  coverage: interval.coverage
})

/**
 * Read-only captured-ledger calculation, not saved-history reconciliation or apply approval.
 * Explicit splits and deletions of adopted rows constrain both calculations identically, so
 * a candidate policy can neither discard a cut nor count deleted coverage again.
 */
export function previewLedgerWorkspacePolicy<TSchema extends Record<string, unknown>>(
  db: BetterSQLite3Database<TSchema>,
  candidate: unknown,
  conversationKeys?: readonly string[]
) {
  return db.transaction((tx) => {
    const current = getWorkspacePolicy(tx)
    if (!current)
      throw new AppError('WORKSPACE_POLICY_REQUIRED', 'Initialize or join a workspace first')
    const policy = readTrackingPolicy(candidate)
    const constraints = readCanonicalHistoryConstraints(tx, conversationKeys)
    // Each side is normalized by its own policy's recorded version. A reviewed version change
    // reads the same captured rows twice; event IDs are identical, only Codex ownership differs.
    const read = (value: TrackingPolicy) =>
      readCanonicalActivity(tx, conversationKeys, {
        normalizationVersion: value.normalizationVersion
      })
    const currentRead = read(current.policy)
    const candidateRead =
      policy.normalizationVersion === current.policy.normalizationVersion
        ? currentRead
        : new Map(
            read(policy).map((entry) => [
              JSON.stringify([entry.provider, entry.conversationId]),
              entry
            ])
          )
    const conversations = currentRead.map((conversation) => {
      if (conversation.status === 'unresolved') return conversation
      const key = JSON.stringify([conversation.provider, conversation.conversationId])
      const candidateConversation = Array.isArray(candidateRead)
        ? conversation
        : candidateRead.get(key)
      // Held under the candidate normalization: the change cannot apply to it silently.
      if (candidateConversation?.status !== 'resolved')
        return (
          candidateConversation ?? {
            provider: conversation.provider,
            conversationId: conversation.conversationId,
            eventIds: conversation.eventIds,
            observationIds: conversation.observationIds,
            status: 'unresolved' as const,
            reason: 'inconsistent-snapshot' as const
          }
        )
      const operations = constraints.get(key)
      const measure = (
        normalized: ResolvedConversation,
        value: TrackingPolicy
      ): ReturnType<typeof constrainCanonicalIntervals> => {
        const intervals = calculateCanonicalIntervals(normalized, value)
        return operations
          ? constrainCanonicalIntervals(normalized, intervals, operations)
          : { intervals, suppressed: [], conflicts: [], invalid: [] }
      }
      const constrainedBefore = measure(conversation, current.policy)
      const constrainedAfter = measure(candidateConversation, policy)
      const before = constrainedBefore.intervals
      const after = constrainedAfter.intervals
      const unassigned = (normalized: ResolvedConversation, intervals: typeof before) => {
        const assigned = new Set(
          intervals.flatMap((interval) => [
            ...interval.coverage.messages.map((event) => event.eventId),
            ...interval.coverage.continuity.flatMap((edge) =>
              edge.progress.map((event) => event.eventId)
            )
          ])
        )
        return normalized.events.filter((event) => !assigned.has(event.eventId))
      }
      // Codex usage no interval counts (unowned, or owned by an uncounted message).
      const unassignedUsage = (normalized: ResolvedConversation, intervals: typeof before) => {
        const included = new Set(
          intervals.flatMap((interval) =>
            (interval.coverage.usage ?? []).map((entry) => entry.checkpointId)
          )
        )
        return (normalized.usage ?? []).filter((entry) => !included.has(entry.checkpointId))
      }
      return {
        provider: conversation.provider,
        conversationId: conversation.conversationId,
        eventIds: conversation.eventIds,
        observationIds: conversation.observationIds,
        status: 'resolved' as const,
        before,
        after,
        transitions: relateCanonicalIntervals(before, after),
        unassigned: {
          before: unassigned(conversation, before),
          after: unassigned(candidateConversation, after)
        },
        ...(conversation.usage
          ? {
              unassignedUsage: {
                before: unassignedUsage(conversation, before),
                after: unassignedUsage(candidateConversation, after)
              }
            }
          : {}),
        // Present only for conversations with explicit operations on adopted rows.
        ...(operations
          ? {
              operations: {
                cuts: operations.cuts,
                // Local rows only; portable facts never pretend a local session exists.
                deletedSessionIds: [
                  ...new Set([
                    ...operations.masks.flatMap((mask) => mask.sessionId ?? []),
                    ...operations.invalid
                      .filter((row) => row.reason !== 'invalid-split')
                      .flatMap((row) => row.sessionId ?? [])
                  ])
                ].sort((a, b) => a - b),
                cutOperationIds: (operations.cutOperations ?? [])
                  .map((row) => row.operationId)
                  .sort(),
                deletionOperationIds: operations.masks
                  .flatMap((mask) => mask.operationId ?? [])
                  .sort(),
                // Portable facts waiting for evidence or contradicting the ledger.
                heldOperations: constrainedAfter.invalid.flatMap((row) =>
                  row.operationId ? [{ operationId: row.operationId, reason: row.reason }] : []
                ),
                invalid: constrainedAfter.invalid,
                suppressed: {
                  before: constrainedBefore.suppressed.map(fragmentBounds),
                  after: constrainedAfter.suppressed.map(fragmentBounds)
                },
                conflicts: {
                  before: constrainedBefore.conflicts.map(fragmentBounds),
                  after: constrainedAfter.conflicts.map(fragmentBounds)
                }
              }
            }
          : {})
      }
    })
    // Portable facts that arrived before any activity of their conversation: held, not lost.
    const captured = new Set(
      conversations.map((row) => JSON.stringify([row.provider, row.conversationId]))
    )
    const waitingOperationIds = [...constraints]
      .filter(([key]) => !captured.has(key))
      .flatMap(([, value]) => [
        ...(value.cutOperations ?? []).map((row) => row.operationId),
        ...value.masks.flatMap((mask) => mask.operationId ?? []),
        ...value.invalid.flatMap((row) => row.operationId ?? [])
      ])
      .sort()
    return {
      scope: 'captured-ledger' as const,
      workspaceId: current.workspaceId,
      baseRevisionId: current.revisionId,
      currentPolicy: current.policy,
      candidatePolicy: policy,
      conversations,
      waitingOperationIds
    }
  })
}
