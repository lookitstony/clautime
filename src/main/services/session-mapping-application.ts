import { eq } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { AppError } from '../../shared/types/ipc'
import { readTrackingPolicy } from '../../shared/tracking-policy'
import { journalWorkspacePolicyChange } from './folder-sync-policy-records'
import { sessions } from '../db/schema/sessions'
import { sessionDerivations, sessionTimeOverrides } from '../db/schema/session-derivations'
import { sessionModelUsage } from '../db/schema/session-model-usage'
import { sessionActivityMappings } from '../db/schema/session-activity-mappings'
import { sessionReplacements } from '../db/schema/session-history'
import { workspacePolicy } from '../db/schema/workspace-policy'
import {
  sessionMappingDecisions,
  sessionMappingEdges,
  sessionMappingOutcomes,
  sessionMappingRevisions,
  workspacePolicyRevisions
} from '../db/schema/session-mapping-revisions'
import { retainInvoiceBillingRefs } from './session-billing'
import { recordSessionRevision } from './session-history'
import { recheckSessionMappingTransitions } from './session-mapping-transitions'
import {
  planSessionMappingApplication,
  type SessionMappingSourceChoice
} from './session-mapping-plan'

export interface SessionMappingApplicationRequest {
  decisionId: string
  candidate: unknown
  expectedFingerprint: string
  choices: SessionMappingSourceChoice[]
  /** Exact held conversation keys and saved-only row IDs shown in the reviewed plan. */
  acknowledgedHeld: string[]
  /** Scanner continuation may select conversations, but cannot change workspace policy. */
  conversationKeys?: string[]
  acknowledgedReductions?: string[]
}

export interface SessionMappingApplicationResult {
  decisionId: string
  policyRevisionId: string
  appliedSessionIds: number[]
  retiredSessionIds: number[]
  held: string[]
}

export function mappingHeldKeys(
  plan: ReturnType<typeof planSessionMappingApplication>,
  conversationKeys?: string[]
): string[] {
  return [
    ...plan.conversations
      .filter(
        (row) =>
          row.status === 'held' &&
          (!conversationKeys ||
            conversationKeys.includes(JSON.stringify([row.provider, row.conversationId])))
      )
      .map((row) => JSON.stringify([row.provider, row.conversationId])),
    ...(conversationKeys ? [] : plan.retainedWithoutActivity.map((id) => `saved:${id}`))
  ].sort()
}

/**
 * Held conversations with captured activity or active saved rows that no adopted mapping
 * covers. A policy change cannot hold these causally (there is no head a later decision
 * could rewrite), and ordinary scans would silently re-measure them under the new policy,
 * so policy changes are refused while any remain. Audit-only groups and saved rows without
 * captured activity are historical and are not included. Neither is a conversation whose
 * saved rows are all adopted history (for example, every adopted row was deleted and later
 * work conflicts with deleted coverage): scans keep managing and holding it through its
 * mappings, so it is reported with its own held reasons (history-operation-conflict)
 * instead of blocking every policy change with a request to link rows that do not exist.
 */
export function unlinkedHeldConversations(
  plan: ReturnType<typeof planSessionMappingApplication>,
  mappedSessionIds: ReadonlySet<number>,
  savedSessionIds: ReadonlyMap<string, readonly number[]> = new Map()
) {
  return plan.conversations.filter((row) => {
    if (row.status !== 'held' || row.heldReasons.includes('audit-only-history')) return false
    if (row.activeSessionIds.length)
      return row.activeSessionIds.some((id) => !mappedSessionIds.has(id))
    const saved = savedSessionIds.get(JSON.stringify([row.provider, row.conversationId])) ?? []
    return !saved.length || saved.some((id) => !mappedSessionIds.has(id))
  })
}

function readHeld(json: string): string[] {
  try {
    const value: unknown = JSON.parse(json)
    return Array.isArray(value) ? value.filter((item) => typeof item === 'string') : []
  } catch {
    return []
  }
}

/** One local decision: freshness, all measurements, lineage and receipt commit together. */
export function applySessionMappingApplication<TSchema extends Record<string, unknown>>(
  db: BetterSQLite3Database<TSchema>,
  request: SessionMappingApplicationRequest
): SessionMappingApplicationResult {
  if (
    !request ||
    typeof request !== 'object' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(request.decisionId) ||
    !Array.isArray(request.choices) ||
    !Array.isArray(request.acknowledgedHeld) ||
    request.acknowledgedHeld.some((key) => typeof key !== 'string') ||
    new Set(request.acknowledgedHeld).size !== request.acknowledgedHeld.length ||
    (request.conversationKeys !== undefined &&
      (!Array.isArray(request.conversationKeys) ||
        !request.conversationKeys.length ||
        request.conversationKeys.some((key) => typeof key !== 'string') ||
        new Set(request.conversationKeys).size !== request.conversationKeys.length))
  )
    throw new AppError('INVALID_MAPPING_DECISION', 'A reviewed mapping decision is required')
  const candidate = readTrackingPolicy(request.candidate)
  const requestJson = JSON.stringify({
    decisionId: request.decisionId,
    candidate,
    expectedFingerprint: request.expectedFingerprint,
    choices: request.choices,
    acknowledgedHeld: [...request.acknowledgedHeld].sort(),
    conversationKeys: request.conversationKeys?.slice().sort(),
    acknowledgedReductions: request.acknowledgedReductions
  })
  return db.transaction(
    (tx) => {
      const existing = tx
        .select()
        .from(sessionMappingDecisions)
        .where(eq(sessionMappingDecisions.id, request.decisionId))
        .get()
      if (existing) {
        const receipt = tx
          .select()
          .from(sessionMappingOutcomes)
          .where(eq(sessionMappingOutcomes.decisionId, request.decisionId))
          .get()
        if (existing.requestJson !== requestJson || !receipt)
          throw new AppError('MAPPING_DECISION_CONFLICT', 'This decision ID has different contents')
        return JSON.parse(receipt.resultJson) as SessionMappingApplicationResult
      }
      // Scanner continuation rechecks only its selected conversations (never a global review).
      const preview = recheckSessionMappingTransitions(
        tx,
        candidate,
        request.expectedFingerprint,
        request.conversationKeys
      )
      const { history } = preview
      const { saved } = history
      // The mutable projection is not evidence: every head must match its retained revision.
      const policy = saved.policyRevisions.find((row) => row.id === history.baseRevisionId)
      if (
        !policy ||
        policy.workspaceId !== history.workspaceId ||
        policy.policyJson !== JSON.stringify(history.currentPolicy)
      )
        throw new AppError('INVALID_POLICY_HEAD', 'The workspace policy needs history review')
      for (const mapping of saved.activityMappings) {
        if (
          request.conversationKeys &&
          !request.conversationKeys.includes(
            JSON.stringify([mapping.provider, mapping.conversationId])
          )
        )
          continue
        const head = saved.mappingRevisions.find((row) => row.id === mapping.revisionId)
        const policy = saved.policyRevisions.find((row) => row.id === mapping.policyRevisionId)
        if (
          !head ||
          head.mappingId !== mapping.id ||
          head.sessionId !== mapping.sessionId ||
          head.snapshotJson !== JSON.stringify(mapping) ||
          policy?.policyJson !== mapping.policyJson ||
          policy?.workspaceId !== mapping.workspaceId
        )
          throw new AppError('INVALID_MAPPING_HEAD', 'An adopted mapping needs history review')
      }
      const plan = planSessionMappingApplication(
        preview,
        request.decisionId,
        request.choices,
        request.acknowledgedReductions
      )
      if (
        request.conversationKeys &&
        (JSON.stringify(candidate) !== JSON.stringify(history.currentPolicy) ||
          request.conversationKeys.some(
            (key) =>
              !plan.conversations.some(
                (row) => JSON.stringify([row.provider, row.conversationId]) === key
              )
          ))
      )
        throw new AppError(
          'INVALID_MAPPING_SELECTION',
          'Selected continuation requires the current policy and known conversations'
        )
      const policyJson = JSON.stringify(candidate)
      const policyChanged = policyJson !== JSON.stringify(history.currentPolicy)
      if (policyChanged) {
        const unlinked = unlinkedHeldConversations(
          plan,
          new Set(saved.activityMappings.map((row) => row.sessionId)),
          new Map(
            history.conversations.map((row) => [
              JSON.stringify([row.provider, row.conversationId]),
              row.savedSessionIds
            ])
          )
        )
        if (unlinked.length) {
          const reasons = [...new Set(unlinked.flatMap((row) => row.heldReasons))].sort()
          throw new AppError(
            'UNLINKED_HISTORY_BLOCKS_POLICY_CHANGE',
            `${unlinked.length} held conversation(s) are not linked to captured activity ` +
              `(${reasons.join(', ')}), so a new tracking policy would stop counting their ` +
              'new work. Link their saved sessions in history review, or let running sessions ' +
              'finish, then review the policy change again. Unresolved or unsupported activity ' +
              'cannot be linked yet: keep the current policy while it has active saved sessions.'
          )
        }
      }
      const held = mappingHeldKeys(plan, request.conversationKeys)
      if (JSON.stringify(held) !== JSON.stringify([...request.acknowledgedHeld].sort()))
        throw new AppError(
          'HELD_HISTORY_ACKNOWLEDGMENT_REQUIRED',
          'Review every held history group'
        )
      const createdAt = new Date().toISOString()
      const targetRevisionId = policyChanged ? request.decisionId : history.baseRevisionId
      const keyOf = (row: { provider: string; conversationId: string }) =>
        JSON.stringify([row.provider, row.conversationId])
      const scope = request.conversationKeys && new Set(request.conversationKeys)
      const inScope = (row: { provider: string; conversationId: string }) =>
        !scope || scope.has(keyOf(row))
      const applied = new Set(
        plan.conversations
          .filter((row) => row.status === 'applicable' && inScope(row))
          .map((row) => keyOf(row))
      )
      // Journal only what this decision reviewed and rewrote. Observed decisions are the
      // policy-changing holds at this revision over conversations it applies: exactly what
      // causal release reads. A policy change starts a new revision and observes none.
      tx.insert(sessionMappingDecisions)
        .values({
          id: request.decisionId,
          requestJson,
          previewFingerprint: preview.fingerprint,
          basePolicyRevisionId: history.baseRevisionId,
          targetPolicyRevisionId: targetRevisionId,
          baseHeadsJson: JSON.stringify(
            saved.activityMappings.filter(inScope).map((row) => [row.id, row.revisionId])
          ),
          planJson: JSON.stringify(
            scope
              ? {
                  ...plan,
                  conversations: plan.conversations.filter(inScope),
                  coverageReductions: plan.coverageReductions.filter(inScope),
                  retainedWithoutActivity: []
                }
              : plan
          ),
          heldJson: JSON.stringify(held),
          observedDecisionIdsJson: JSON.stringify(
            policyChanged
              ? []
              : saved.mappingDecisions
                  .filter(
                    (row) =>
                      row.targetPolicyRevisionId === history.baseRevisionId &&
                      row.basePolicyRevisionId !== row.targetPolicyRevisionId &&
                      readHeld(row.heldJson).some((item) => applied.has(item))
                  )
                  .map((row) => row.id)
          ),
          createdAt
        })
        .run()
      if (policyChanged) {
        tx.insert(workspacePolicyRevisions)
          .values({
            id: targetRevisionId,
            workspaceId: history.workspaceId,
            parentRevisionId: history.baseRevisionId,
            policyJson,
            decisionId: request.decisionId,
            createdAt
          })
          .run()
        tx.update(workspacePolicy)
          .set({ revisionId: targetRevisionId, policyJson })
          .where(eq(workspacePolicy.slot, 1))
          .run()
      }
      retainInvoiceBillingRefs(tx)
      const result: SessionMappingApplicationResult = {
        decisionId: request.decisionId,
        policyRevisionId: targetRevisionId,
        appliedSessionIds: [],
        retiredSessionIds: [],
        held
      }
      for (const conversation of plan.conversations) {
        if (conversation.status !== 'applicable') continue
        if (
          request.conversationKeys &&
          !request.conversationKeys.includes(
            JSON.stringify([conversation.provider, conversation.conversationId])
          )
        )
          continue
        const replacementRevisions = new Map<number, string>()
        for (const id of conversation.retiredSessionIds) {
          const predecessor = saved.sessions.find((row) => row.id === id)!
          replacementRevisions.set(
            id,
            recordSessionRevision(tx, predecessor, 'policy', predecessor, {
              decisionId: request.decisionId,
              successorMappingIds: conversation.successors
                .filter((row) => row.predecessorSessionIds.includes(id))
                .map((row) => row.mappingId)
            })
          )
        }
        for (const successor of conversation.successors) {
          const source = saved.sessions.find((row) => row.id === successor.sourceSessionId)
          const inheritedSources = new Set(
            saved.sessions
              .filter((row) =>
                (successor.predecessorSessionIds.length
                  ? successor.predecessorSessionIds
                  : conversation.activeSessionIds
                ).includes(row.id)
              )
              .map((row) => row.sourceFile)
          )
          const sourceFile =
            source?.sourceFile ?? (inheritedSources.size === 1 ? [...inheritedSources][0] : null)
          const measurement = {
            ...successor.effective,
            promptCount: successor.interval.promptCount,
            inputTokens: successor.interval.inputTokens,
            outputTokens: successor.interval.outputTokens,
            updatedAt: createdAt
          }
          const sessionId =
            successor.keepSessionId ??
            tx
              .insert(sessions)
              .values({
                ...measurement,
                source: 'auto',
                tool: conversation.provider as typeof sessions.$inferInsert.tool,
                claudeSessionId: conversation.conversationId,
                projectPath: '',
                ...successor.metadata,
                sourceFile,
                createdAt
              })
              .returning({ id: sessions.id })
              .get().id
          if (successor.keepSessionId !== null)
            tx.update(sessions).set(measurement).where(eq(sessions.id, sessionId)).run()
          const baseline = {
            startedAt: successor.interval.startedAt,
            endedAt: successor.interval.endedAt,
            durationMinutes: successor.interval.durationMinutes
          }
          tx.insert(sessionDerivations)
            .values({ sessionId, ...baseline })
            .onConflictDoUpdate({ target: sessionDerivations.sessionId, set: baseline })
            .run()
          tx.insert(sessionTimeOverrides)
            .values({ sessionId, ...successor.timeOverrides })
            .onConflictDoUpdate({
              target: sessionTimeOverrides.sessionId,
              set: successor.timeOverrides
            })
            .run()
          tx.delete(sessionModelUsage).where(eq(sessionModelUsage.sessionId, sessionId)).run()
          for (const usage of successor.interval.modelUsage)
            tx.insert(sessionModelUsage)
              .values({ sessionId, ...usage })
              .run()
          const values = {
            id: successor.mappingId,
            sessionId,
            version: 1,
            workspaceId: history.workspaceId,
            policyRevisionId: targetRevisionId,
            policyJson,
            provider: conversation.provider,
            conversationId: conversation.conversationId,
            intervalJson: JSON.stringify(successor.interval),
            previewFingerprint: preview.fingerprint,
            createdAt,
            revisionId: successor.revisionId
          }
          const mapping = tx
            .insert(sessionActivityMappings)
            .values(values)
            .onConflictDoUpdate({ target: sessionActivityMappings.id, set: values })
            .returning()
            .get()
          tx.insert(sessionMappingRevisions)
            .values({
              id: successor.revisionId,
              mappingId: mapping.id,
              sessionId,
              kind: successor.kind,
              snapshotJson: JSON.stringify(mapping),
              decisionId: request.decisionId,
              createdAt
            })
            .run()
          for (const parentRevisionId of successor.predecessorRevisionIds)
            tx.insert(sessionMappingEdges)
              .values({ childRevisionId: successor.revisionId, parentRevisionId })
              .run()
          for (const predecessorSessionId of successor.predecessorSessionIds) {
            const revisionId = replacementRevisions.get(predecessorSessionId)
            if (revisionId)
              tx.insert(sessionReplacements)
                .values({ predecessorSessionId, successorSessionId: sessionId, revisionId })
                .run()
          }
          result.appliedSessionIds.push(sessionId)
        }
        result.retiredSessionIds.push(...conversation.retiredSessionIds)
      }
      tx.insert(sessionMappingOutcomes)
        .values({ decisionId: request.decisionId, resultJson: JSON.stringify(result), createdAt })
        .run()
      if (policyChanged) journalWorkspacePolicyChange(tx, candidate)
      return result
    },
    { behavior: 'immediate' }
  )
}
