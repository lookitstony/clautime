import { randomUUID } from 'node:crypto'
import { eq, inArray } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { AppError } from '../../shared/types/ipc'
import type { SessionModelUsage } from '../../shared/types/session'
import { sessions, type Session } from '../db/schema/sessions'
import { sessionDerivations, sessionTimeOverrides } from '../db/schema/session-derivations'
import { sessionModelUsage } from '../db/schema/session-model-usage'
import { sessionActivityMappings } from '../db/schema/session-activity-mappings'
import { sessionDeletions } from '../db/schema/session-deletions'
import { sessionReplacements, sessionSplits } from '../db/schema/session-history'
import {
  sessionMappingDecisions,
  sessionMappingEdges,
  sessionMappingOutcomes,
  sessionMappingRevisions,
  workspacePolicyRevisions
} from '../db/schema/session-mapping-revisions'
import { readCanonicalActivity } from './canonical-activity'
import {
  calculateCanonicalIntervals,
  canonicalUsageKey,
  constrainCanonicalIntervals,
  readCanonicalIntervalSnapshot
} from './canonical-intervals'
import { getWorkspacePolicy, readCanonicalHistoryConstraints } from './workspace-policy'
import { isMappingHead, isPolicyHoldReleased, readPolicyHolds } from './canonical-history-proof'
import { previewSessionMappingTransitions } from './session-mapping-transitions'
import { coverageHash, derivedUuid, planSessionMappingApplication } from './session-mapping-plan'
import { recordSessionRevision } from './session-history'
import { retainInvoiceBillingRefs } from './session-billing'
import { journalSessionDeletion, journalSessionSplit } from './folder-sync-history-records'

type Interval = ReturnType<typeof calculateCanonicalIntervals>[number]
type Plan = ReturnType<typeof planSessionMappingApplication>

function refuse(code: string, message: string): never {
  throw new AppError(code, message)
}

/** The conversation must already match its retained activity: nothing pending, nothing held. */
function currentConversation(plan: Plan, key: string, action: string) {
  const conversation = plan.conversations.find(
    (row) => JSON.stringify([row.provider, row.conversationId]) === key
  )
  if (!conversation)
    refuse(
      'HISTORY_REVIEW_REQUIRED',
      `This conversation's retained activity is unavailable, so it cannot be ${action}. Saved history was not changed.`
    )
  if (conversation.status !== 'applicable')
    refuse(
      'HISTORY_REVIEW_REQUIRED',
      `This conversation needs history review (${conversation.heldReasons.join(', ')}) before a session can be ${action}. Saved history was not changed.`
    )
  if (
    conversation.retiredSessionIds.length ||
    conversation.successors.some(
      (row) => row.kind !== 'continue' || row.keepSessionId === null || !row.intervalUnchanged
    ) ||
    conversation.activeSessionIds.some(
      (id) => !conversation.successors.some((row) => row.keepSessionId === id)
    )
  )
    refuse(
      'SCAN_REQUIRED',
      'New activity for this conversation has not been saved yet. Scan for sessions, then try again. Saved history was not changed.'
    )
  return conversation
}

/**
 * Holding policy decisions this conversation was already released from, by the scanner's
 * causal rule (isPolicyHoldReleased). An operation always targets an active row, so release
 * is proven through the active heads. New heads and deletions written by an operation
 * observe the same holds to stay released.
 */
function releasedHolds<TSchema extends Record<string, unknown>>(
  tx: BetterSQLite3Database<TSchema>,
  key: string,
  revisionId: string,
  activeSessionIds: number[],
  action: string
): string[] {
  const held = (): never =>
    refuse(
      'MAPPING_HELD',
      `A reviewed tracking policy change still holds this conversation, so a session cannot be ${action}. Review workspace history in Settings first. Saved history was not changed.`
    )
  const holding = readPolicyHolds(tx, revisionId).filter(
    (row) => !row.held || row.held.includes(key)
  )
  if (!holding.length) return []
  const heads = activeSessionIds.length
    ? tx
        .select({ revisionId: sessionActivityMappings.revisionId })
        .from(sessionActivityMappings)
        .where(inArray(sessionActivityMappings.sessionId, activeSessionIds))
        .all()
    : []
  if (!heads.length || heads.length !== activeSessionIds.length) held()
  const headIds = heads.map((row) => row.revisionId)
  for (const hold of holding)
    if (!hold.held || !isPolicyHoldReleased(tx, hold.id, revisionId, headIds, undefined)) held()
  return holding.map((row) => row.id).sort()
}

/** Everything an explicit operation on one adopted row proves inside its own transaction. */
function readMappedOperation<TSchema extends Record<string, unknown>>(
  tx: BetterSQLite3Database<TSchema>,
  sessionId: number,
  action: 'split' | 'deleted'
) {
  const row = tx.select().from(sessions).where(eq(sessions.id, sessionId)).get()
  if (!row) refuse('SESSION_NOT_FOUND', `Session ${sessionId} not found`)
  if (
    tx.select().from(sessionDeletions).where(eq(sessionDeletions.sessionId, sessionId)).get() ||
    tx.select().from(sessionSplits).where(eq(sessionSplits.parentSessionId, sessionId)).get() ||
    tx
      .select()
      .from(sessionReplacements)
      .where(eq(sessionReplacements.predecessorSessionId, sessionId))
      .get()
  )
    refuse(
      'SESSION_NOT_ACTIVE',
      `Session ${sessionId} is audit history; use its active parts instead`
    )
  const mapping = tx
    .select()
    .from(sessionActivityMappings)
    .where(eq(sessionActivityMappings.sessionId, sessionId))
    .get()
  if (!mapping)
    refuse('ACTIVITY_MAPPING_REQUIRED', `Session ${sessionId} has no adopted activity coverage`)
  const policy = getWorkspacePolicy(tx)
  if (!policy)
    refuse('WORKSPACE_POLICY_REQUIRED', 'Initialize or join a workspace before changing history')
  const head = mapping.revisionId
    ? tx
        .select()
        .from(sessionMappingRevisions)
        .where(eq(sessionMappingRevisions.id, mapping.revisionId))
        .get()
    : undefined
  const measuredUnder = tx
    .select()
    .from(workspacePolicyRevisions)
    .where(eq(workspacePolicyRevisions.id, mapping.policyRevisionId))
    .get()
  if (
    !isMappingHead(mapping, head) ||
    measuredUnder?.policyJson !== mapping.policyJson ||
    measuredUnder.workspaceId !== mapping.workspaceId ||
    row.source !== 'auto' ||
    row.tool !== mapping.provider ||
    row.claudeSessionId !== mapping.conversationId
  )
    refuse(
      'INVALID_MAPPING_HEAD',
      `This session's adopted activity needs history review before it can be ${action}. Saved history was not changed.`
    )
  if (
    mapping.policyRevisionId !== policy.revisionId ||
    mapping.policyJson !== JSON.stringify(policy.policy)
  )
    refuse(
      'MAPPING_POLICY_REVIEW',
      `This session was measured under an earlier tracking policy. Review the policy change in Settings before it can be ${action}. Saved history was not changed.`
    )
  if (row.status !== 'completed')
    refuse(
      'SESSION_RUNNING',
      `This session is still running. It can be ${action} after it completes.`
    )
  const key = JSON.stringify([mapping.provider, mapping.conversationId])
  const decisionId = randomUUID()
  const preview = previewSessionMappingTransitions(tx, policy.policy, [key])
  const conversation = currentConversation(
    planSessionMappingApplication(preview, decisionId),
    key,
    action
  )
  const observed = releasedHolds(tx, key, policy.revisionId, conversation.activeSessionIds, action)
  const successor = conversation.successors.find((entry) => entry.keepSessionId === sessionId)!
  return {
    row,
    mapping,
    head,
    policy,
    key,
    decisionId,
    preview,
    conversation,
    observed,
    interval: successor.interval
  }
}
type MappedOperation = ReturnType<typeof readMappedOperation>

/** Immutable request, plan and receipt of one explicit operation, like any mapping decision. */
function recordOperation<TSchema extends Record<string, unknown>>(
  tx: BetterSQLite3Database<TSchema>,
  op: MappedOperation,
  request: Record<string, unknown>,
  plan: Record<string, unknown>,
  createdAt: string
): void {
  tx.insert(sessionMappingDecisions)
    .values({
      id: op.decisionId,
      requestJson: JSON.stringify({ decisionId: op.decisionId, ...request }),
      previewFingerprint: op.preview.fingerprint,
      basePolicyRevisionId: op.policy.revisionId,
      targetPolicyRevisionId: op.policy.revisionId,
      baseHeadsJson: JSON.stringify(
        op.preview.history.saved.activityMappings
          .filter((row) => JSON.stringify([row.provider, row.conversationId]) === op.key)
          .map((row) => [row.id, row.revisionId])
      ),
      planJson: JSON.stringify(plan),
      heldJson: '[]',
      observedDecisionIdsJson: JSON.stringify(op.observed),
      createdAt
    })
    .run()
}

/** The written result must read back as the current, unchanged state of its conversation. */
function verifyWritten<TSchema extends Record<string, unknown>>(
  tx: BetterSQLite3Database<TSchema>,
  op: MappedOperation,
  expectedActive: number[],
  action: 'split' | 'deleted'
) {
  const failed = (detail: string): never =>
    refuse(
      'HISTORY_OPERATION_UNVERIFIED',
      `The session could not be ${action} exactly against its retained activity (${detail}). Saved history was not changed.`
    )
  let conversation: ReturnType<typeof currentConversation>
  try {
    conversation = currentConversation(
      planSessionMappingApplication(
        previewSessionMappingTransitions(tx, op.policy.policy, [op.key]),
        randomUUID()
      ),
      op.key,
      action
    )
  } catch (error) {
    if (error instanceof AppError) failed(error.message)
    throw error
  }
  const numeric = (ids: Array<number | null>) => JSON.stringify([...ids].sort((a, b) => a! - b!))
  if (numeric(conversation.successors.map((row) => row.keepSessionId)) !== numeric(expectedActive))
    failed('unexpected saved sessions')
  return conversation
}

function modelTotals(rows: SessionModelUsage[]): string {
  const totals = new Map<string, number[]>()
  for (const row of rows) {
    const sum = totals.get(row.model) ?? [0, 0, 0, 0]
    sum[0] += row.inputTokens
    sum[1] += row.outputTokens
    sum[2] += row.cacheCreationInputTokens
    sum[3] += row.cacheReadInputTokens
    totals.set(row.model, sum)
  }
  return JSON.stringify([...totals].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
}

/** Parts own every counted fact, usage checkpoint and gap instant of the parent exactly once. */
export function isExactCanonicalPartition(parent: Interval, parts: Interval[]): boolean {
  const ids = (items: Array<{ eventId: string }>) => JSON.stringify(items.map((e) => e.eventId))
  const progress = (interval: Interval) =>
    interval.coverage.continuity.flatMap((edge) => edge.progress)
  const usage = (interval: Interval) => (interval.coverage.usage ?? []).map(canonicalUsageKey)
  const span = (interval: Interval) =>
    interval.coverage.continuity.reduce(
      (total, edge) => total + Date.parse(edge.endedAt) - Date.parse(edge.startedAt),
      0
    )
  const sum = (key: 'durationMinutes' | 'promptCount' | 'inputTokens' | 'outputTokens') =>
    parts.reduce((total, part) => total + part[key], 0) === parent[key]
  return (
    parts.length > 1 &&
    parts[0].startedAt === parent.startedAt &&
    parts[parts.length - 1].endedAt === parent.endedAt &&
    parts.every((part, index) => !index || parts[index - 1].endedAt === part.startedAt) &&
    ids(parent.coverage.messages) === ids(parts.flatMap((part) => part.coverage.messages)) &&
    ids(progress(parent)) === ids(parts.flatMap(progress)) &&
    JSON.stringify(usage(parent).sort()) === JSON.stringify(parts.flatMap(usage).sort()) &&
    span(parent) === parts.reduce((total, part) => total + span(part), 0) &&
    parts.every((part) =>
      part.coverage.continuity.every((edge) =>
        parent.coverage.continuity.some(
          (whole) =>
            whole.from.eventId === edge.from.eventId &&
            whole.to.eventId === edge.to.eventId &&
            whole.startedAt <= edge.startedAt &&
            edge.endedAt <= whole.endedAt
        )
      )
    ) &&
    (['durationMinutes', 'promptCount', 'inputTokens', 'outputTokens'] as const).every(sum) &&
    modelTotals(parent.modelUsage) === modelTotals(parts.flatMap((part) => part.modelUsage))
  )
}

/**
 * Split an adopted session at an explicit UTC instant. The cut becomes a reviewed constraint
 * of its conversation: both parts are recalculated from the whole detector interval with every
 * cut, own their messages, prompts, tokens and clipped gaps exactly, and are adopted by a new
 * immutable decision whose revisions descend from the parent's head. The parent stays as
 * non-counting audit history with its invoice references. An edited duration cannot be
 * divided between the parts and is refused rather than reallocated.
 */
export function splitMappedSession<TSchema extends Record<string, unknown>>(
  db: BetterSQLite3Database<TSchema>,
  sessionId: number,
  splitAt: string
): [Session, Session] {
  const cutAt = Date.parse(splitAt)
  if (!Number.isFinite(cutAt)) throw new Error('Invalid split point')
  const cut = new Date(cutAt).toISOString()
  return db.transaction(
    (tx) => {
      const op = readMappedOperation(tx, sessionId, 'split')
      const { row, mapping, interval, policy } = op
      if (!(Date.parse(interval.startedAt) < cutAt && cutAt < Date.parse(interval.endedAt)))
        refuse(
          'INVALID_SPLIT_POINT',
          `Split point must be between the measured activity start ${interval.startedAt} and end ${interval.endedAt}.`
        )
      const canonical = readCanonicalActivity(tx, [op.key], {
        normalizationVersion: policy.policy.normalizationVersion
      }).find((entry) => JSON.stringify([entry.provider, entry.conversationId]) === op.key)
      if (canonical?.status !== 'resolved')
        refuse(
          'HISTORY_REVIEW_REQUIRED',
          'Retained activity for this conversation is unresolved. Saved history was not changed.'
        )
      const constraints = readCanonicalHistoryConstraints(tx, [op.key]).get(op.key) ?? {
        cuts: [],
        masks: [],
        invalid: []
      }
      const recalculated = constrainCanonicalIntervals(
        canonical,
        calculateCanonicalIntervals(canonical, policy.policy),
        { ...constraints, cuts: [...constraints.cuts, cut] }
      ).intervals
      const parts = [
        recalculated.find((part) => part.startedAt === interval.startedAt && part.endedAt === cut),
        recalculated.find((part) => part.startedAt === cut && part.endedAt === interval.endedAt)
      ]
      if (!parts[0] || !parts[1] || !isExactCanonicalPartition(interval, parts as Interval[]))
        refuse(
          'SPLIT_EVIDENCE_CHANGED',
          'Retained activity could not be divided exactly at this point. Scan for sessions and try again. Saved history was not changed.'
        )
      const [first, second] = parts as [Interval, Interval]

      // Edited times belong to one part only when their scope is unambiguous.
      const flags = tx
        .select()
        .from(sessionTimeOverrides)
        .where(eq(sessionTimeOverrides.sessionId, sessionId))
        .get()
      const edited = {
        startedAt: Date.parse(row.startedAt) !== Date.parse(interval.startedAt),
        endedAt: Date.parse(row.endedAt) !== Date.parse(interval.endedAt),
        durationMinutes: row.durationMinutes !== interval.durationMinutes
      }
      // An explicit duration override is an edit even when it equals the measurement: the
      // parts would otherwise inherit a frozen duration that later growth never updates.
      if (edited.durationMinutes || flags?.durationMinutes)
        refuse(
          'SPLIT_TIME_EDIT_AMBIGUOUS',
          `Session ${sessionId} has an edited duration (${row.durationMinutes} min; measured ${interval.durationMinutes} min). Splitting would have to divide that edited time between the parts, so it was not split. Restore its measured duration of ${interval.durationMinutes} minutes, split it, then edit each part.`
        )
      if (edited.startedAt && Date.parse(row.startedAt) >= cutAt)
        refuse(
          'SPLIT_TIME_EDIT_AMBIGUOUS',
          `Session ${sessionId} has an edited start (${row.startedAt}) at or after the split point, so neither part can keep it. Choose a later split point or restore its start to ${interval.startedAt}.`
        )
      if (edited.endedAt && Date.parse(row.endedAt) <= cutAt)
        refuse(
          'SPLIT_TIME_EDIT_AMBIGUOUS',
          `Session ${sessionId} has an edited end (${row.endedAt}) at or before the split point, so neither part can keep it. Choose an earlier split point or restore its end to ${interval.endedAt}.`
        )
      const displayed = [
        {
          startedAt: edited.startedAt ? row.startedAt : first.startedAt,
          endedAt: first.endedAt,
          durationMinutes: first.durationMinutes
        },
        {
          startedAt: second.startedAt,
          endedAt: edited.endedAt ? row.endedAt : second.endedAt,
          durationMinutes: second.durationMinutes
        }
      ]
      // Both parts are measured durations; only an unambiguous edited bound carries over.
      const overrides = [
        {
          startedAt: Number(!!flags?.startedAt || edited.startedAt),
          endedAt: 0,
          durationMinutes: 0
        },
        { startedAt: 0, endedAt: Number(!!flags?.endedAt || edited.endedAt), durationMinutes: 0 }
      ]

      const now = new Date().toISOString()
      retainInvoiceBillingRefs(tx)
      const children = ([first, second] as const).map((part, index) => {
        const child = tx
          .insert(sessions)
          .values({
            ...row,
            id: undefined,
            ...displayed[index],
            promptCount: part.promptCount,
            inputTokens: part.inputTokens,
            outputTokens: part.outputTokens,
            createdAt: now,
            updatedAt: now
          })
          .returning()
          .get()
        tx.insert(sessionDerivations)
          .values({
            sessionId: child.id,
            startedAt: part.startedAt,
            endedAt: part.endedAt,
            durationMinutes: part.durationMinutes
          })
          .run()
        tx.insert(sessionTimeOverrides)
          .values({ sessionId: child.id, ...overrides[index] })
          .run()
        for (const usage of part.modelUsage)
          tx.insert(sessionModelUsage)
            .values({ sessionId: child.id, ...usage })
            .run()
        return child
      }) as [Session, Session]
      const revisionId = recordSessionRevision(tx, row, 'split', row, {
        splitAt: cut,
        children,
        decisionId: op.decisionId
      })
      tx.insert(sessionSplits)
        .values({
          revisionId,
          legacyRecordId: null,
          parentSessionId: sessionId,
          firstSessionId: children[0].id,
          secondSessionId: children[1].id,
          sourceFile: row.sourceFile,
          tool: row.tool,
          claudeSessionId: row.claudeSessionId,
          startedAt: interval.startedAt,
          endedAt: interval.endedAt,
          splitAt: cut
        })
        .run()

      const planned = [first, second].map((part, index) => {
        const hash = coverageHash(mapping.provider, mapping.conversationId, part.coverage)
        return {
          sessionId: children[index].id,
          coverageHash: hash,
          mappingId: derivedUuid('session-activity-mapping:split:v1', op.decisionId, hash),
          revisionId: derivedUuid('session-mapping-revision:split:v1', op.decisionId, hash)
        }
      })
      recordOperation(
        tx,
        op,
        { operation: 'split', sessionId, splitAt: cut },
        {
          version: 1,
          scope: 'session-history-split',
          sessionId,
          mappingId: mapping.id,
          mappingRevisionId: mapping.revisionId,
          splitAt: cut,
          parts: planned
        },
        now
      )
      planned.forEach((entry, index) => {
        const saved = tx
          .insert(sessionActivityMappings)
          .values({
            id: entry.mappingId,
            sessionId: entry.sessionId,
            version: 1,
            workspaceId: policy.workspaceId,
            policyRevisionId: policy.revisionId,
            policyJson: JSON.stringify(policy.policy),
            provider: mapping.provider,
            conversationId: mapping.conversationId,
            intervalJson: JSON.stringify([first, second][index]),
            previewFingerprint: op.preview.fingerprint,
            createdAt: now,
            revisionId: entry.revisionId
          })
          .returning()
          .get()
        tx.insert(sessionMappingRevisions)
          .values({
            id: entry.revisionId,
            mappingId: saved.id,
            sessionId: entry.sessionId,
            kind: 'split',
            snapshotJson: JSON.stringify(saved),
            decisionId: op.decisionId,
            createdAt: now
          })
          .run()
        tx.insert(sessionMappingEdges)
          .values({ childRevisionId: entry.revisionId, parentRevisionId: op.head.id })
          .run()
      })
      tx.insert(sessionMappingOutcomes)
        .values({
          decisionId: op.decisionId,
          resultJson: JSON.stringify({
            decisionId: op.decisionId,
            operation: 'split',
            policyRevisionId: policy.revisionId,
            appliedSessionIds: children.map((child) => child.id),
            retiredSessionIds: [sessionId],
            held: []
          }),
          createdAt: now
        })
        .run()
      // Portable cut: canonical target and instant only, never local IDs or paths.
      journalSessionSplit(tx, {
        provider: mapping.provider,
        conversationId: mapping.conversationId,
        splitAt: cut
      })
      verifyWritten(
        tx,
        op,
        [
          ...op.conversation.activeSessionIds.filter((id) => id !== sessionId),
          ...children.map((child) => child.id)
        ],
        'split'
      )
      return children
    },
    { behavior: 'immediate' }
  )
}

/**
 * Delete an adopted session from active history. Its immutable head coverage becomes a mask:
 * copies and rebuilds keep that work suppressed under any policy, while independent later
 * activity of the conversation continues. Work that later continues across the deleted
 * coverage is held for review instead of being counted or suppressed. The row, its usage and
 * its invoice references remain as audit history. With a workspace connection the deleted
 * coverage is also journaled as a portable fact; `observedSessionEditHeads` are the
 * session-edit revisions the user saw (supplied by the session metadata sync hook).
 */
export function deleteMappedSession<TSchema extends Record<string, unknown>>(
  db: BetterSQLite3Database<TSchema>,
  sessionId: number,
  options: { observedSessionEditHeads?: readonly string[] } = {}
): void {
  db.transaction(
    (tx) => {
      const op = readMappedOperation(tx, sessionId, 'deleted')
      const { row, mapping, interval } = op
      // The mask is the head's stored coverage; the decision binds exactly that coverage.
      const stored = readCanonicalIntervalSnapshot(mapping.intervalJson, mapping.provider)
      if (!stored)
        refuse(
          'INVALID_MAPPING_HEAD',
          "This session's adopted activity needs history review before it can be deleted. Saved history was not changed."
        )
      const now = new Date().toISOString()
      retainInvoiceBillingRefs(tx)
      recordOperation(
        tx,
        op,
        { operation: 'delete', sessionId },
        {
          version: 1,
          scope: 'session-history-deletion',
          sessionId,
          mappingId: mapping.id,
          mappingRevisionId: mapping.revisionId,
          coverageHash: coverageHash(mapping.provider, mapping.conversationId, stored.coverage)
        },
        now
      )
      tx.insert(sessionDeletions)
        .values({
          id: randomUUID(),
          sessionId,
          sourceFile: row.sourceFile,
          tool: row.tool,
          claudeSessionId: row.claudeSessionId,
          startedAt: interval.startedAt,
          endedAt: interval.endedAt,
          createdAt: now,
          legacyRecordId: null
        })
        .run()
      tx.insert(sessionMappingOutcomes)
        .values({
          decisionId: op.decisionId,
          resultJson: JSON.stringify({
            decisionId: op.decisionId,
            operation: 'delete',
            policyRevisionId: op.policy.revisionId,
            appliedSessionIds: [],
            retiredSessionIds: [sessionId],
            held: []
          }),
          createdAt: now
        })
        .run()
      journalSessionDeletion(tx, {
        provider: mapping.provider,
        conversationId: mapping.conversationId,
        coverage: stored.coverage,
        observedSessionEditHeads: options.observedSessionEditHeads
      })
      const conversation = verifyWritten(
        tx,
        op,
        op.conversation.activeSessionIds.filter((id) => id !== sessionId),
        'deleted'
      )
      if (!conversation.suppressed?.some((entry) => entry.sessionIds.includes(sessionId)))
        refuse(
          'HISTORY_OPERATION_UNVERIFIED',
          'The session could not be deleted exactly against its retained activity. Saved history was not changed.'
        )
    },
    { behavior: 'immediate' }
  )
}
