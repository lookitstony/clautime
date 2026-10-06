import { and, eq, inArray, like, ne } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { sessionActivityMappings } from '../db/schema/session-activity-mappings'
import { sessionDeletions } from '../db/schema/session-deletions'
import { sessionSplits } from '../db/schema/session-history'
import {
  sessionMappingDecisions,
  sessionMappingEdges,
  sessionMappingOutcomes,
  sessionMappingRevisions
} from '../db/schema/session-mapping-revisions'
import {
  readCanonicalIntervalSnapshot,
  type CanonicalIntervalCoverage
} from './canonical-intervals'
import { coverageHash, derivedUuid } from './session-mapping-plan'

type Db<TSchema extends Record<string, unknown>> = Pick<BetterSQLite3Database<TSchema>, 'select'>
type Mapping = typeof sessionActivityMappings.$inferSelect
type Revision = typeof sessionMappingRevisions.$inferSelect
type Decision = typeof sessionMappingDecisions.$inferSelect

/** A deletion of an adopted row proven by its own recorded decision and receipt. */
export interface ProvenHistoryDeletion {
  sessionId: number
  coverage: CanonicalIntervalCoverage
  decisionId: string
  policyRevisionId: string
  observedDecisionIds: string[]
}

/**
 * A local adopted row retired because imported portable deletion facts already delete all of
 * its coverage. The local decision proves only the binding (row head, coverage, fact IDs); the
 * facts themselves must still read back and cover it (readCanonicalHistoryConstraints). It is
 * never a local deletion proof and is never exported as a new portable fact.
 */
export interface ProjectedHistoryDeletion {
  sessionId: number
  coverage: CanonicalIntervalCoverage
  decisionId: string
  portableOperationIds: string[]
}

/** Explicit operations of one conversation. Unproven rows are reported, never skipped. */
export interface CanonicalHistoryProofs {
  cuts: Array<{ parentSessionId: number; splitAt: string; decisionId: string }>
  deletions: ProvenHistoryDeletion[]
  projected?: ProjectedHistoryDeletion[]
  invalid: Array<{ sessionId: number; reason: 'invalid-split' | 'invalid-deleted-coverage' }>
}

/** Plan scope of a projected portable deletion (see ProjectedHistoryDeletion). */
export const PORTABLE_DELETION_PROJECTION_SCOPE = 'session-history-portable-deletion'

function readJson(text: string | undefined): unknown {
  if (text === undefined) return undefined
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
function strings(value: unknown): string[] | null {
  return Array.isArray(value) && value.every((item) => typeof item === 'string') ? value : null
}
const same = (value: unknown, expected: unknown) =>
  JSON.stringify(value) === JSON.stringify(expected)
const keyOf = (provider: string, conversationId: string) =>
  JSON.stringify([provider, conversationId])

/** The current projection of a mapping matches its immutable head revision exactly. */
export function isMappingHead(mapping: Mapping, head: Revision | undefined): head is Revision {
  return (
    !!head &&
    head.id === mapping.revisionId &&
    head.mappingId === mapping.id &&
    head.sessionId === mapping.sessionId &&
    head.snapshotJson === JSON.stringify(mapping)
  )
}

/**
 * The immutable request, plan and receipt of one explicit operation, exactly as
 * canonical-history-operations records them. Anything else is not an operation.
 */
function readOperation(
  decision: Decision,
  receipt: string | undefined,
  scope:
    | 'session-history-split'
    | 'session-history-deletion'
    | typeof PORTABLE_DELETION_PROJECTION_SCOPE,
  operation: 'split' | 'delete' | 'project-portable-deletion',
  mapping: Mapping
) {
  const plan = readJson(decision.planJson)
  const request = readJson(decision.requestJson)
  const result = readJson(receipt)
  const heads = readJson(decision.baseHeadsJson)
  const observed = strings(readJson(decision.observedDecisionIdsJson))
  if (
    !object(plan) ||
    !object(request) ||
    !object(result) ||
    !observed ||
    !Array.isArray(heads) ||
    plan.version !== 1 ||
    plan.scope !== scope ||
    plan.sessionId !== mapping.sessionId ||
    plan.mappingId !== mapping.id ||
    plan.mappingRevisionId !== mapping.revisionId ||
    request.decisionId !== decision.id ||
    request.operation !== operation ||
    request.sessionId !== mapping.sessionId ||
    result.decisionId !== decision.id ||
    result.operation !== operation ||
    result.policyRevisionId !== decision.targetPolicyRevisionId ||
    !same(result.held, []) ||
    !same(result.retiredSessionIds, [mapping.sessionId]) ||
    decision.heldJson !== '[]' ||
    decision.basePolicyRevisionId !== decision.targetPolicyRevisionId ||
    // The operation observed the exact head it retired.
    !heads.some((head) => same(head, [mapping.id, mapping.revisionId]))
  )
    return null
  return { plan, request, result, observed }
}

/** Causal ancestry through immutable edges; never inferred from timestamps. */
function descends(from: string | null, to: string, parents: Map<string, string[]>): boolean {
  const seen = new Set<string>()
  const queue = from ? [from] : []
  while (queue.length) {
    const id = queue.pop()!
    if (id === to) return true
    if (seen.has(id)) continue
    seen.add(id)
    queue.push(...(parents.get(id) ?? []))
  }
  return false
}

/**
 * Explicit splits and deletions of adopted rows, per conversation key, each proven against
 * the decision that created it: its request, plan and receipt, the retired head it observed,
 * and (for splits) the original split revisions and edges of both parts. Parts may have
 * advanced since the split (append, later policy review, repeated cuts); only their ancestry
 * back to the original split revision is required. Legacy/manual operations of adopted rows
 * and anything unproven are reported as invalid so their conversation is held.
 */
export function readCanonicalHistoryProofs<TSchema extends Record<string, unknown>>(
  db: Db<TSchema>,
  conversationKeys?: readonly string[]
): Map<string, CanonicalHistoryProofs> {
  const scope = conversationKeys ? new Set(conversationKeys) : null
  const all = db.select().from(sessionActivityMappings).all()
  const bySession = new Map(all.map((row) => [row.sessionId, row]))
  const mappings = new Map(
    all
      .filter((row) => !scope || scope.has(keyOf(row.provider, row.conversationId)))
      .map((row) => [row.sessionId, row])
  )
  const result = new Map<string, CanonicalHistoryProofs>()
  if (!mappings.size) return result
  const entry = (mapping: Mapping) => {
    const key = keyOf(mapping.provider, mapping.conversationId)
    const value = result.get(key) ?? { cuts: [], deletions: [], projected: [], invalid: [] }
    result.set(key, value)
    return value
  }
  const splits = db
    .select()
    .from(sessionSplits)
    .all()
    .filter(
      (row) =>
        mappings.has(row.parentSessionId) &&
        bySession.has(row.firstSessionId) &&
        bySession.has(row.secondSessionId) &&
        !row.legacyRecordId
    )
  const deletions = db
    .select()
    .from(sessionDeletions)
    .all()
    .filter((row) => mappings.has(row.sessionId))
  if (!splits.length && !deletions.length) return result

  // Only the mappings these operations involve: retired heads and both parts' histories.
  const involved = [
    ...new Set([
      ...deletions.map((row) => mappings.get(row.sessionId)!.id),
      ...splits.flatMap((row) =>
        [row.parentSessionId, row.firstSessionId, row.secondSessionId].map(
          (id) => bySession.get(id)!.id
        )
      )
    ])
  ]
  const revisions = new Map(
    db
      .select()
      .from(sessionMappingRevisions)
      .where(inArray(sessionMappingRevisions.mappingId, involved))
      .all()
      .map((row) => [row.id, row])
  )
  const parents = new Map<string, string[]>()
  const edges = new Set<string>()
  if (revisions.size)
    for (const edge of db
      .select()
      .from(sessionMappingEdges)
      .where(inArray(sessionMappingEdges.childRevisionId, [...revisions.keys()]))
      .all()) {
      parents.set(edge.childRevisionId, [
        ...(parents.get(edge.childRevisionId) ?? []),
        edge.parentRevisionId
      ])
      edges.add(JSON.stringify([edge.childRevisionId, edge.parentRevisionId]))
    }
  // Candidate operation decisions by the session they retired; each is verified below.
  const candidates = new Map<string, Decision[]>()
  for (const decision of db
    .select()
    .from(sessionMappingDecisions)
    .where(like(sessionMappingDecisions.planJson, '%"scope":"session-history-%'))
    .all()) {
    const plan = readJson(decision.planJson)
    if (!object(plan) || typeof plan.scope !== 'string') continue
    const id = JSON.stringify([plan.scope, plan.sessionId])
    candidates.set(id, [...(candidates.get(id) ?? []), decision])
  }
  const decisionIds = [...candidates.values()].flat().map((row) => row.id)
  const receipts = new Map(
    decisionIds.length
      ? db
          .select()
          .from(sessionMappingOutcomes)
          .where(inArray(sessionMappingOutcomes.decisionId, decisionIds))
          .all()
          .map((row) => [row.decisionId, row.resultJson])
      : []
  )
  const only = (kind: string, sessionId: number) => {
    const found = candidates.get(JSON.stringify([kind, sessionId])) ?? []
    return found.length === 1 ? found[0] : undefined
  }

  for (const split of splits) {
    const parent = mappings.get(split.parentSessionId)!
    const target = entry(parent)
    const invalid = () =>
      target.invalid.push({ sessionId: split.parentSessionId, reason: 'invalid-split' })
    const whole = readCanonicalIntervalSnapshot(parent.intervalJson, parent.provider)
    const cut = Date.parse(split.splitAt)
    const decision = only('session-history-split', split.parentSessionId)
    const op =
      decision &&
      readOperation(decision, receipts.get(decision.id), 'session-history-split', 'split', parent)
    const children = [split.firstSessionId, split.secondSessionId]
    const parts = op && Array.isArray(op.plan.parts) ? op.plan.parts : []
    if (
      !decision ||
      !op ||
      !whole ||
      !isMappingHead(parent, revisions.get(parent.revisionId ?? '')) ||
      split.tool !== parent.provider ||
      split.claudeSessionId !== parent.conversationId ||
      !Number.isFinite(cut) ||
      new Date(cut).toISOString() !== split.splitAt ||
      split.startedAt !== whole.startedAt ||
      split.endedAt !== whole.endedAt ||
      !(Date.parse(whole.startedAt) < cut && cut < Date.parse(whole.endedAt)) ||
      op.plan.splitAt !== split.splitAt ||
      op.request.splitAt !== split.splitAt ||
      !same(op.result.appliedSessionIds, children) ||
      parts.length !== 2
    ) {
      invalid()
      continue
    }
    const bounds = [
      [whole.startedAt, split.splitAt],
      [split.splitAt, whole.endedAt]
    ]
    const proven = children.every((sessionId, index) => {
      const part: unknown = parts[index]
      if (!object(part) || part.sessionId !== sessionId || typeof part.coverageHash !== 'string')
        return false
      const hash = part.coverageHash
      const mappingId = derivedUuid('session-activity-mapping:split:v1', decision.id, hash)
      const revisionId = derivedUuid('session-mapping-revision:split:v1', decision.id, hash)
      const original = revisions.get(revisionId)
      const snapshot = readJson(original?.snapshotJson)
      const interval =
        object(snapshot) && typeof snapshot.intervalJson === 'string'
          ? readCanonicalIntervalSnapshot(snapshot.intervalJson, parent.provider)
          : null
      const current = bySession.get(sessionId)!
      return (
        part.mappingId === mappingId &&
        part.revisionId === revisionId &&
        !!original &&
        !!interval &&
        original.kind === 'split' &&
        original.decisionId === decision.id &&
        original.mappingId === mappingId &&
        original.sessionId === sessionId &&
        object(snapshot) &&
        snapshot.id === mappingId &&
        snapshot.sessionId === sessionId &&
        snapshot.revisionId === revisionId &&
        snapshot.provider === parent.provider &&
        snapshot.conversationId === parent.conversationId &&
        interval.startedAt === bounds[index][0] &&
        interval.endedAt === bounds[index][1] &&
        coverageHash(parent.provider, parent.conversationId, interval.coverage) === hash &&
        edges.has(JSON.stringify([revisionId, parent.revisionId])) &&
        // The part may have advanced since; its current head must descend from the split.
        current.id === mappingId &&
        descends(current.revisionId, revisionId, parents)
      )
    })
    if (!proven) invalid()
    else
      target.cuts.push({
        parentSessionId: split.parentSessionId,
        splitAt: split.splitAt,
        decisionId: decision.id
      })
  }

  for (const deletion of deletions) {
    const mapping = mappings.get(deletion.sessionId)!
    const target = entry(mapping)
    const interval = readCanonicalIntervalSnapshot(mapping.intervalJson, mapping.provider)
    const decision = only('session-history-deletion', deletion.sessionId)
    const projection = only(PORTABLE_DELETION_PROJECTION_SCOPE, deletion.sessionId)
    if (
      projection ||
      candidates.has(JSON.stringify([PORTABLE_DELETION_PROJECTION_SCOPE, deletion.sessionId]))
    ) {
      const bound =
        projection &&
        !decision &&
        readOperation(
          projection,
          receipts.get(projection.id),
          PORTABLE_DELETION_PROJECTION_SCOPE,
          'project-portable-deletion',
          mapping
        )
      const ids = bound ? strings(bound.plan.portableOperationIds) : null
      if (
        !bound ||
        !ids?.length ||
        !same(ids, [...new Set(ids)].sort()) ||
        !same(bound.request.portableOperationIds, ids) ||
        !interval ||
        deletion.legacyRecordId ||
        !isMappingHead(mapping, revisions.get(mapping.revisionId ?? '')) ||
        deletion.tool !== mapping.provider ||
        deletion.claudeSessionId !== mapping.conversationId ||
        deletion.startedAt !== interval.startedAt ||
        deletion.endedAt !== interval.endedAt ||
        bound.plan.coverageHash !==
          coverageHash(mapping.provider, mapping.conversationId, interval.coverage) ||
        !same(bound.result.appliedSessionIds, [])
      )
        target.invalid.push({ sessionId: deletion.sessionId, reason: 'invalid-deleted-coverage' })
      else
        target.projected!.push({
          sessionId: deletion.sessionId,
          coverage: interval.coverage,
          decisionId: projection!.id,
          portableOperationIds: ids
        })
      continue
    }
    const op =
      decision &&
      readOperation(
        decision,
        receipts.get(decision.id),
        'session-history-deletion',
        'delete',
        mapping
      )
    if (
      !decision ||
      !op ||
      !interval ||
      deletion.legacyRecordId ||
      !isMappingHead(mapping, revisions.get(mapping.revisionId ?? '')) ||
      deletion.tool !== mapping.provider ||
      deletion.claudeSessionId !== mapping.conversationId ||
      deletion.startedAt !== interval.startedAt ||
      deletion.endedAt !== interval.endedAt ||
      op.plan.coverageHash !==
        coverageHash(mapping.provider, mapping.conversationId, interval.coverage) ||
      !same(op.result.appliedSessionIds, [])
    ) {
      target.invalid.push({ sessionId: deletion.sessionId, reason: 'invalid-deleted-coverage' })
      continue
    }
    target.deletions.push({
      sessionId: deletion.sessionId,
      coverage: interval.coverage,
      decisionId: decision.id,
      policyRevisionId: decision.targetPolicyRevisionId,
      observedDecisionIds: op.observed
    })
  }
  return result
}

/** Policy-changing decisions that created this revision and may hold conversations. */
export function readPolicyHolds<TSchema extends Record<string, unknown>>(
  db: Db<TSchema>,
  revisionId: string
): Array<{ id: string; held: string[] | null }> {
  return db
    .select({ id: sessionMappingDecisions.id, heldJson: sessionMappingDecisions.heldJson })
    .from(sessionMappingDecisions)
    .where(
      and(
        eq(sessionMappingDecisions.targetPolicyRevisionId, revisionId),
        ne(sessionMappingDecisions.basePolicyRevisionId, revisionId)
      )
    )
    .all()
    .map((row) => ({ id: row.id, held: strings(readJson(row.heldJson)) }))
}

/**
 * Whether a policy hold over one conversation was causally released at its revision: every
 * active head was written by another decision at that revision that observed the hold. With
 * no active head left, every deletion made at that revision (each necessarily after the hold
 * created it) must be a proven operation that observed the hold, and there must be one. Rows
 * deleted under an earlier revision were never held. Clocks and arrival order are not used.
 */
export function isPolicyHoldReleased<TSchema extends Record<string, unknown>>(
  db: Db<TSchema>,
  holdId: string,
  revisionId: string,
  headRevisionIds: Array<string | null>,
  proofs: CanonicalHistoryProofs | undefined
): boolean {
  if (!headRevisionIds.length) {
    const later = (proofs?.deletions ?? []).filter((row) => row.policyRevisionId === revisionId)
    return (
      !!proofs &&
      !proofs.invalid.length &&
      later.length > 0 &&
      later.every((row) => row.decisionId !== holdId && row.observedDecisionIds.includes(holdId))
    )
  }
  if (headRevisionIds.some((id) => !id)) return false
  const ids = [...new Set(headRevisionIds as string[])]
  const heads = db
    .select({ id: sessionMappingRevisions.id, decisionId: sessionMappingRevisions.decisionId })
    .from(sessionMappingRevisions)
    .where(inArray(sessionMappingRevisions.id, ids))
    .all()
  if (heads.length !== ids.length) return false
  const writerIds = [...new Set(heads.flatMap((row) => row.decisionId ?? []))]
  const writers = new Map(
    writerIds.length
      ? db
          .select({
            id: sessionMappingDecisions.id,
            observedDecisionIdsJson: sessionMappingDecisions.observedDecisionIdsJson
          })
          .from(sessionMappingDecisions)
          .where(
            and(
              inArray(sessionMappingDecisions.id, writerIds),
              eq(sessionMappingDecisions.targetPolicyRevisionId, revisionId)
            )
          )
          .all()
          .map((row) => [row.id, strings(readJson(row.observedDecisionIdsJson))])
      : []
  )
  return heads.every(
    (row) =>
      !!row.decisionId &&
      row.decisionId !== holdId &&
      !!writers.get(row.decisionId)?.includes(holdId)
  )
}
