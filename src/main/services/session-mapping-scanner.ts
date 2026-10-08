import { randomUUID } from 'node:crypto'
import { and, eq, inArray } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { AppError } from '../../shared/types/ipc'
import type { DetectedSession } from '../../shared/types/session'
import { sessions } from '../db/schema/sessions'
import { sessionActivityMappings } from '../db/schema/session-activity-mappings'
import { sessionDeletions } from '../db/schema/session-deletions'
import { sessionReplacements, sessionSplits } from '../db/schema/session-history'
import { SessionReconciliationError } from './session-history'
import { getWorkspacePolicy } from './workspace-policy'
import {
  isPolicyHoldReleased,
  readCanonicalHistoryProofs,
  readPolicyHolds
} from './canonical-history-proof'
import { previewSessionMappingTransitions } from './session-mapping-transitions'
import { planSessionMappingApplication } from './session-mapping-plan'
import { applySessionMappingApplication } from './session-mapping-application'

const conversationKey = (provider: string, conversationId: string) =>
  JSON.stringify([provider, conversationId])

export class SessionMappingReconciliationError extends SessionReconciliationError {}

/**
 * Scanner routing for one source, run first inside its scan/rebuild transaction.
 * Returns null only when no conversation of this source is mapping-managed and the
 * policy change that created the current revision does not hold them; ordinary per-file
 * reconciliation may then run. Managed sources advance only by same-policy append
 * through the reviewed application path. Anything else throws a scanner error.
 *
 * Only a policy-changing decision holds sources, scoped to the revision it created. A
 * same-policy review changes no measurement basis: unadopted and unsupported sources stay
 * on ordinary reconciliation, and mapped groups are re-derived by this source's own plan.
 * A hold is released only when every active head of that conversation was written by
 * another decision targeting the same revision that explicitly observed the holding
 * decision. When every adopted row was deleted after the hold, each of those proven delete
 * operations must have observed it instead. Computer clocks and arrival order do not
 * establish this relationship. Saved-row holds remain held; applying refuses policy
 * changes that would leave active unlinked conversations held without a head to release.
 */
export function reconcileMappedSource<TSchema extends Record<string, unknown>>(
  db: BetterSQLite3Database<TSchema>,
  detected: DetectedSession[],
  sourceFile: string
): number | null {
  function hold(detail: string): never {
    throw new SessionMappingReconciliationError(
      `Session reconciliation needs review for ${sourceFile}. ${detail} Saved history was retained.`
    )
  }
  const local = db
    .select()
    .from(sessions)
    .where(and(eq(sessions.source, 'auto'), eq(sessions.sourceFile, sourceFile)))
    .all()
  const keys = new Set<string>()
  for (const row of detected)
    if (row.claudeSessionId) keys.add(conversationKey(row.tool, row.claudeSessionId))
  for (const row of local)
    if (row.claudeSessionId) keys.add(conversationKey(row.tool, row.claudeSessionId))
  const unidentified =
    detected.some((row) => !row.claudeSessionId) || local.some((row) => !row.claudeSessionId)
  const conversationIds = [...new Set([...keys].map((key) => (JSON.parse(key) as string[])[1]))]
  // Copies of the same conversation on other sources belong to the same group.
  const related = conversationIds.length
    ? db
        .select()
        .from(sessions)
        .where(and(eq(sessions.source, 'auto'), inArray(sessions.claudeSessionId, conversationIds)))
        .all()
        .filter((row) => keys.has(conversationKey(row.tool, row.claudeSessionId!)))
    : []
  const mappings = conversationIds.length
    ? db
        .select()
        .from(sessionActivityMappings)
        .where(inArray(sessionActivityMappings.conversationId, conversationIds))
        .all()
        .filter((row) => keys.has(conversationKey(row.provider, row.conversationId)))
    : []

  const policy = (() => {
    try {
      return getWorkspacePolicy(db)
    } catch (error) {
      if (error instanceof AppError) hold('The workspace policy needs history review.')
      throw error
    }
  })()
  if (!policy) {
    if (mappings.length) hold('Mapped activity has no workspace policy.')
    return null
  }
  const policyJson = JSON.stringify(policy.policy)

  const mappedIds = mappings.map((row) => row.sessionId)
  const inactive = new Set<number | null>(
    mappedIds.length
      ? [
          ...db
            .select({ id: sessionDeletions.sessionId })
            .from(sessionDeletions)
            .where(inArray(sessionDeletions.sessionId, mappedIds))
            .all()
            .map((row) => row.id),
          ...db
            .select({ id: sessionSplits.parentSessionId })
            .from(sessionSplits)
            .where(inArray(sessionSplits.parentSessionId, mappedIds))
            .all()
            .map((row) => row.id),
          ...db
            .select({ id: sessionReplacements.predecessorSessionId })
            .from(sessionReplacements)
            .where(inArray(sessionReplacements.predecessorSessionId, mappedIds))
            .all()
            .map((row) => row.id)
        ]
      : []
  )
  const heads = mappings.filter((row) => !inactive.has(row.sessionId))
  // Never auto-migrate a mapping measured under another policy revision.
  if (
    heads.some((row) => row.policyRevisionId !== policy.revisionId || row.policyJson !== policyJson)
  )
    hold('Mapped activity was measured under a different workspace policy.')

  const holding = readPolicyHolds(db, policy.revisionId)
  const savedKeys = new Set([...local, ...related].map((row) => `saved:${row.id}`))
  let proofs: ReturnType<typeof readCanonicalHistoryProofs> | undefined
  for (const decision of holding) {
    if (!decision.held) hold('A reviewed mapping decision is unreadable.')
    for (const item of decision.held) {
      if (savedKeys.has(item)) hold('A reviewed policy decision held this saved history.')
      if (!keys.has(item)) continue
      const active = heads.filter(
        (row) => conversationKey(row.provider, row.conversationId) === item
      )
      // With no active head left, only proven deletions that observed the hold release it.
      if (!active.length && !proofs) proofs = readCanonicalHistoryProofs(db, [...keys])
      const released = isPolicyHoldReleased(
        db,
        decision.id,
        policy.revisionId,
        active.map((row) => row.revisionId),
        proofs?.get(item)
      )
      if (!released)
        hold(
          active.length
            ? 'A reviewed policy decision held this conversation.'
            : 'A reviewed policy decision held this conversation, and none of its sessions remain for a later review to release it. Review workspace history in Settings.'
        )
    }
  }

  if (!mappings.length) return null
  const managed = new Set(mappings.map((row) => conversationKey(row.provider, row.conversationId)))
  // Wholly managed or wholly held: never let raw reconciliation touch part of this source.
  if (unidentified || [...keys].some((key) => !managed.has(key)))
    hold('This source mixes mapped and unmapped conversations.')

  const selected = [...keys].sort()
  try {
    // Scoped to this source's conversations; apply rechecks the same scope.
    const preview = previewSessionMappingTransitions(db, policy.policy, selected)
    const { history } = preview
    const { saved } = history
    const policyHead = saved.policyRevisions.find((row) => row.id === history.baseRevisionId)
    if (
      history.baseRevisionId !== policy.revisionId ||
      !policyHead ||
      policyHead.workspaceId !== history.workspaceId ||
      policyHead.policyJson !== policyJson
    )
      hold('The workspace policy needs history review.')
    for (const mapping of saved.activityMappings) {
      if (!keys.has(conversationKey(mapping.provider, mapping.conversationId))) continue
      const head = saved.mappingRevisions.find((row) => row.id === mapping.revisionId)
      if (
        !head ||
        head.mappingId !== mapping.id ||
        head.sessionId !== mapping.sessionId ||
        head.snapshotJson !== JSON.stringify(mapping)
      )
        hold('An adopted mapping needs history review.')
    }
    const snapshots = new Map(saved.activityMappings.map((row) => [row.sessionId, row]))
    const decisionId = randomUUID()
    const plan = planSessionMappingApplication(preview, decisionId)
    let changed = false
    let count = 0
    for (const key of selected) {
      const conversation = plan.conversations.find(
        (row) => conversationKey(row.provider, row.conversationId) === key
      )
      if (!conversation) hold('Mapped activity is missing from the retained ledger.')
      if (conversation.status !== 'applicable')
        hold(`Mapped activity is held (${conversation.heldReasons.join(', ')}).`)
      if (conversation.retiredSessionIds.length)
        hold('Mapped activity would replace saved sessions.')
      let kept = 0
      let lastEnd = -Infinity
      // Verified deletion masks are still history anchors when every visible row
      // was deleted. Only independent work after that retained coverage may grow.
      for (const suppressed of conversation.suppressed ?? [])
        lastEnd = Math.max(lastEnd, Date.parse(suppressed.endedAt))
      for (const successor of conversation.successors) {
        if (
          successor.policyChanged ||
          (successor.kind !== 'continue' && successor.kind !== 'adopt')
        )
          hold('Mapped activity needs split, merge or policy review.')
        if (successor.kind !== 'continue') continue
        const mapping =
          successor.keepSessionId === null ? undefined : snapshots.get(successor.keepSessionId)
        const previous = mapping && (JSON.parse(mapping.intervalJson) as typeof successor.interval)
        // Continuation keeps the saved row and only extends its end.
        if (
          !mapping ||
          !previous ||
          mapping.policyRevisionId !== policy.revisionId ||
          mapping.policyJson !== policyJson ||
          previous.coverage.messages[0]?.eventId !==
            successor.interval.coverage.messages[0]?.eventId ||
          previous.startedAt !== successor.interval.startedAt ||
          Date.parse(successor.interval.endedAt) < Date.parse(previous.endedAt)
        )
          hold('Mapped activity changed other than by appending.')
        if (!successor.intervalUnchanged) changed = true
        kept++
        lastEnd = Math.max(lastEnd, Date.parse(successor.interval.endedAt))
      }
      for (const successor of conversation.successors) {
        if (successor.kind !== 'adopt') continue
        // New work may only follow every kept interval, never backfill between them.
        if (
          (!kept && !Number.isFinite(lastEnd)) ||
          Date.parse(successor.interval.startedAt) <= lastEnd
        )
          hold('Mapped activity gained earlier or unlinked intervals.')
        changed = true
      }
      count += conversation.successors.length
    }
    if (!changed) return count
    const result = applySessionMappingApplication(db, {
      decisionId,
      candidate: policy.policy,
      expectedFingerprint: preview.fingerprint,
      choices: [],
      acknowledgedHeld: [],
      conversationKeys: selected
    })
    if (result.retiredSessionIds.length || new Set(result.appliedSessionIds).size !== count)
      hold('Mapped activity changed during application.')
    return count
  } catch (error) {
    if (error instanceof AppError) hold(error.message)
    throw error
  }
}
