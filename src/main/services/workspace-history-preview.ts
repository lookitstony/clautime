import { createHash } from 'node:crypto'
import { and, eq, inArray, ne, or, sql, type Column } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { activityIdentities, activityObservations } from '../db/schema/activity-evidence'
import { sessions } from '../db/schema/sessions'
import { sessionDerivations, sessionTimeOverrides } from '../db/schema/session-derivations'
import { sessionModelUsage } from '../db/schema/session-model-usage'
import { sessionActivityMappings } from '../db/schema/session-activity-mappings'
import {
  workspacePolicyRevisions,
  sessionMappingRevisions,
  sessionMappingEdges,
  sessionMappingDecisions,
  sessionMappingOutcomes
} from '../db/schema/session-mapping-revisions'
import { sessionDeletions } from '../db/schema/session-deletions'
import { sessionLegacyRecords } from '../db/schema/session-legacy'
import { manualTimeEntries } from '../db/schema/manual-time-entries'
import {
  sessionRevisions,
  sessionSplits,
  sessionReplacements,
  sessionBillingRefs
} from '../db/schema/session-history'
import {
  sessionReconciliationCases,
  sessionReconciliationResolutions
} from '../db/schema/session-reconciliation'
import { invoices, invoiceLineItems } from '../db/schema/invoices'
import type { SessionModelUsage } from '../../shared/types/session'
import { requireExplicitTimestamp } from '../../shared/tracking-policy'
import { AppError } from '../../shared/types/ipc'
import {
  isMappedHistoryDeletion,
  isMappedHistorySplit,
  previewLedgerWorkspacePolicy
} from './workspace-policy'
import { sameCanonicalInterval } from './canonical-intervals'

type Measurement = {
  startedAt: string
  endedAt: string
  durationMinutes: number
  promptCount: number
  inputTokens: number
  outputTokens: number
  modelUsage: SessionModelUsage[]
}
type Bounds = Pick<Measurement, 'startedAt' | 'endedAt'>
type ReviewReason =
  | 'missing-conversation-id'
  | 'missing-ledger-activity'
  | 'unresolved-ledger-activity'
  | 'protected-history'
  | 'missing-baseline'
  | 'invalid-saved-time'
  | 'baseline-coverage-mismatch'
  | 'saved-measurements-differ'
  | 'ambiguous-candidate-mapping'
  | 'invalid-preserved-time'
  | 'saved-activity-mapping-mismatch'
  | 'history-operation-review'
type Comparison = {
  sessionId: number
  disposition: 'active' | 'deleted' | 'split' | 'replaced'
  conversationIndex: number | null
} & (
  | { status: 'preserved'; reason: 'manual-entry' | 'audit-history' }
  | { status: 'review-required'; reason: ReviewReason }
  | {
      status: 'comparable'
      mappingBasis: 'measurement-only' | 'adopted-event-coverage'
      mappingId: string | null
      beforeIndex: number
      afterIndex: number
      preservedTimeFields: Array<'startedAt' | 'endedAt' | 'durationMinutes'>
      effectiveMeasurement: Measurement
    }
)

function compatibleSnapshot(
  json: string,
  interval: Parameters<typeof sameCanonicalInterval>[1]
): boolean {
  try {
    return sameCanonicalInterval(JSON.parse(json), interval)
  } catch {
    return false
  }
}

function sameBounds(a: Bounds, b: Bounds): boolean {
  return (
    Date.parse(a.startedAt) === Date.parse(b.startedAt) &&
    Date.parse(a.endedAt) === Date.parse(b.endedAt)
  )
}
function validTimes(value: Bounds & { durationMinutes: number }): boolean {
  try {
    requireExplicitTimestamp(value.startedAt)
    requireExplicitTimestamp(value.endedAt)
    return (
      Date.parse(value.startedAt) <= Date.parse(value.endedAt) &&
      Number.isFinite(value.durationMinutes) &&
      value.durationMinutes >= 0
    )
  } catch {
    return false
  }
}
function usage(rows: SessionModelUsage[]): string {
  return JSON.stringify(
    rows
      .map((row) => ({
        model: row.model,
        inputTokens: row.inputTokens,
        outputTokens: row.outputTokens,
        cacheCreationInputTokens: row.cacheCreationInputTokens,
        cacheReadInputTokens: row.cacheReadInputTokens
      }))
      .sort((a, b) => (a.model < b.model ? -1 : a.model > b.model ? 1 : 0))
  )
}

function readScope(value: unknown): Set<string> | null {
  if (value === undefined) return null
  const invalid = () =>
    new AppError('INVALID_HISTORY_SCOPE', 'Select distinct conversations to compare')
  if (!Array.isArray(value) || !value.length || new Set(value).size !== value.length)
    throw invalid()
  for (const item of value) {
    let parsed: unknown
    try {
      parsed = typeof item === 'string' ? JSON.parse(item) : undefined
    } catch {
      throw invalid()
    }
    if (
      !Array.isArray(parsed) ||
      parsed.length !== 2 ||
      parsed.some((part) => typeof part !== 'string') ||
      JSON.stringify(parsed) !== item
    )
      throw invalid()
  }
  return new Set(value as string[])
}

type Db<TSchema extends Record<string, unknown>> = BetterSQLite3Database<TSchema>
const conversationKey = (provider: string, conversationId: string | null) =>
  JSON.stringify([provider, conversationId])

/** One bound JSON list however many values, so each query keeps its own ORDER BY. */
const within = (column: Column, values: readonly (string | number)[]) =>
  sql`${column} IN (SELECT value FROM json_each(${JSON.stringify(values)}))`

// Decisions and receipts are immutable (triggers), so their IDs bind them; plan,
// request and result payloads are not re-read. Held keys drive causal release.
const decisionColumns = {
  id: sessionMappingDecisions.id,
  basePolicyRevisionId: sessionMappingDecisions.basePolicyRevisionId,
  targetPolicyRevisionId: sessionMappingDecisions.targetPolicyRevisionId,
  heldJson: sessionMappingDecisions.heldJson
}

/** Read whole even when scoped: every invoice is shown; reconciliation keys rows in JSON. */
function readSharedSaved<TSchema extends Record<string, unknown>>(tx: Db<TSchema>) {
  return {
    policyRevisions: tx
      .select()
      .from(workspacePolicyRevisions)
      .orderBy(workspacePolicyRevisions.id)
      .all(),
    invoices: tx.select().from(invoices).orderBy(invoices.id).all(),
    invoiceLineItems: tx.select().from(invoiceLineItems).orderBy(invoiceLineItems.id).all(),
    reconciliationCases: tx
      .select()
      .from(sessionReconciliationCases)
      .orderBy(sessionReconciliationCases.sourceFile)
      .all(),
    reconciliationResolutions: tx
      .select()
      .from(sessionReconciliationResolutions)
      .orderBy(
        sessionReconciliationResolutions.sourceFile,
        sessionReconciliationResolutions.sequence
      )
      .all()
  }
}

function readAllSaved<TSchema extends Record<string, unknown>>(tx: Db<TSchema>) {
  const shared = readSharedSaved(tx)
  const saved = {
    sessions: tx.select().from(sessions).orderBy(sessions.id).all(),
    policyRevisions: shared.policyRevisions,
    mappingRevisions: tx
      .select()
      .from(sessionMappingRevisions)
      .orderBy(sessionMappingRevisions.id)
      .all(),
    mappingEdges: tx
      .select()
      .from(sessionMappingEdges)
      .orderBy(sessionMappingEdges.childRevisionId, sessionMappingEdges.parentRevisionId)
      .all(),
    mappingDecisions: tx
      .select(decisionColumns)
      .from(sessionMappingDecisions)
      .orderBy(sessionMappingDecisions.id)
      .all(),
    mappingOutcomes: tx
      .select({ decisionId: sessionMappingOutcomes.decisionId })
      .from(sessionMappingOutcomes)
      .orderBy(sessionMappingOutcomes.decisionId)
      .all(),
    activityMappings: tx
      .select()
      .from(sessionActivityMappings)
      .orderBy(sessionActivityMappings.sessionId)
      .all(),
    derivations: tx.select().from(sessionDerivations).orderBy(sessionDerivations.sessionId).all(),
    timeOverrides: tx
      .select()
      .from(sessionTimeOverrides)
      .orderBy(sessionTimeOverrides.sessionId)
      .all(),
    modelUsage: tx
      .select()
      .from(sessionModelUsage)
      .orderBy(sessionModelUsage.sessionId, sessionModelUsage.model, sessionModelUsage.id)
      .all(),
    revisions: tx
      .select()
      .from(sessionRevisions)
      .orderBy(sessionRevisions.sessionId, sessionRevisions.sequence)
      .all(),
    splits: tx.select().from(sessionSplits).orderBy(sessionSplits.parentSessionId).all(),
    replacements: tx
      .select()
      .from(sessionReplacements)
      .orderBy(sessionReplacements.predecessorSessionId, sessionReplacements.successorSessionId)
      .all(),
    deletions: tx.select().from(sessionDeletions).orderBy(sessionDeletions.sessionId).all(),
    legacyRecords: tx
      .select()
      .from(sessionLegacyRecords)
      .orderBy(sessionLegacyRecords.sessionId)
      .all(),
    manualEntries: tx.select().from(manualTimeEntries).orderBy(manualTimeEntries.sessionId).all(),
    billingRefs: tx
      .select()
      .from(sessionBillingRefs)
      .orderBy(
        sessionBillingRefs.sessionId,
        sessionBillingRefs.stripeInvoiceId,
        sessionBillingRefs.testMode
      )
      .all(),
    invoices: shared.invoices,
    invoiceLineItems: shared.invoiceLineItems,
    reconciliationCases: shared.reconciliationCases,
    reconciliationResolutions: shared.reconciliationResolutions
  }
  return {
    saved,
    mappedIds: new Set(saved.activityMappings.map((row) => row.sessionId)),
    policyRevisionIds: new Set(
      saved.revisions.filter((row) => row.kind === 'policy').map((row) => row.id)
    )
  }
}
type SavedRead = ReturnType<typeof readAllSaved>

/**
 * Exactly what a full read filtered to the selected conversations shows: their automatic rows
 * and per-session facts, current mapping heads, the holding decisions at this revision and
 * every invoice. Protection of those rows needs a little more, returned separately: whether
 * split parts outside the scope are adopted, and which linked replacements a policy made.
 * Every protecting row names a selected row's ID or source file, so none is missed.
 */
function readScopedSaved<TSchema extends Record<string, unknown>>(
  tx: Db<TSchema>,
  scope: ReadonlySet<string>,
  baseRevisionId: string
): SavedRead {
  const conversationIds = [...new Set([...scope].map((item) => (JSON.parse(item) as string[])[1]))]
  const rows = tx
    .select()
    .from(sessions)
    .where(within(sessions.claudeSessionId, conversationIds))
    .orderBy(sessions.id)
    .all()
    .filter(
      (row) =>
        row.source === 'auto' &&
        !!row.claudeSessionId &&
        scope.has(conversationKey(row.tool, row.claudeSessionId))
    )
  const ids = rows.map((row) => row.id)
  const selected = new Set(ids)
  const mine = (id: number | null | undefined) => typeof id === 'number' && selected.has(id)
  const files = new Set(rows.map((row) => row.sourceFile))
  const shared = readSharedSaved(tx)
  const splits = tx
    .select()
    .from(sessionSplits)
    .where(
      or(
        within(sessionSplits.parentSessionId, ids),
        within(sessionSplits.firstSessionId, ids),
        within(sessionSplits.secondSessionId, ids)
      )
    )
    .orderBy(sessionSplits.parentSessionId)
    .all()
  const replacements = tx
    .select()
    .from(sessionReplacements)
    .where(
      or(
        within(sessionReplacements.predecessorSessionId, ids),
        within(sessionReplacements.successorSessionId, ids)
      )
    )
    .orderBy(sessionReplacements.predecessorSessionId, sessionReplacements.successorSessionId)
    .all()
  const related = [
    ...new Set([
      ...ids,
      ...splits.flatMap((row) => [row.parentSessionId, row.firstSessionId, row.secondSessionId])
    ])
  ]
  const mappingRows = tx
    .select()
    .from(sessionActivityMappings)
    .where(
      or(
        within(sessionActivityMappings.sessionId, related),
        within(sessionActivityMappings.conversationId, conversationIds)
      )
    )
    .orderBy(sessionActivityMappings.sessionId)
    .all()
  const activityMappings = mappingRows.filter(
    (row) => mine(row.sessionId) || scope.has(conversationKey(row.provider, row.conversationId))
  )
  const heads = [
    ...new Set(activityMappings.flatMap((row) => (row.revisionId ? [row.revisionId] : [])))
  ]
  const mappingDecisions = tx
    .select(decisionColumns)
    .from(sessionMappingDecisions)
    .where(
      and(
        eq(sessionMappingDecisions.targetPolicyRevisionId, baseRevisionId),
        ne(
          sessionMappingDecisions.basePolicyRevisionId,
          sessionMappingDecisions.targetPolicyRevisionId
        )
      )
    )
    .orderBy(sessionMappingDecisions.id)
    .all()
  const saved = {
    sessions: rows,
    policyRevisions: shared.policyRevisions,
    mappingRevisions: tx
      .select()
      .from(sessionMappingRevisions)
      .where(within(sessionMappingRevisions.id, heads))
      .orderBy(sessionMappingRevisions.id)
      .all(),
    mappingEdges: tx
      .select()
      .from(sessionMappingEdges)
      .where(within(sessionMappingEdges.childRevisionId, heads))
      .orderBy(sessionMappingEdges.childRevisionId, sessionMappingEdges.parentRevisionId)
      .all(),
    mappingDecisions,
    mappingOutcomes: tx
      .select({ decisionId: sessionMappingOutcomes.decisionId })
      .from(sessionMappingOutcomes)
      .where(
        within(
          sessionMappingOutcomes.decisionId,
          mappingDecisions.map((row) => row.id)
        )
      )
      .orderBy(sessionMappingOutcomes.decisionId)
      .all(),
    activityMappings,
    derivations: tx
      .select()
      .from(sessionDerivations)
      .where(within(sessionDerivations.sessionId, ids))
      .orderBy(sessionDerivations.sessionId)
      .all(),
    timeOverrides: tx
      .select()
      .from(sessionTimeOverrides)
      .where(within(sessionTimeOverrides.sessionId, ids))
      .orderBy(sessionTimeOverrides.sessionId)
      .all(),
    modelUsage: tx
      .select()
      .from(sessionModelUsage)
      .where(within(sessionModelUsage.sessionId, ids))
      .orderBy(sessionModelUsage.sessionId, sessionModelUsage.model, sessionModelUsage.id)
      .all(),
    revisions: tx
      .select()
      .from(sessionRevisions)
      .where(within(sessionRevisions.sessionId, ids))
      .orderBy(sessionRevisions.sessionId, sessionRevisions.sequence)
      .all(),
    splits,
    replacements,
    deletions: tx
      .select()
      .from(sessionDeletions)
      .where(within(sessionDeletions.sessionId, ids))
      .orderBy(sessionDeletions.sessionId)
      .all(),
    legacyRecords: tx
      .select()
      .from(sessionLegacyRecords)
      .where(within(sessionLegacyRecords.sessionId, ids))
      .orderBy(sessionLegacyRecords.sessionId)
      .all(),
    manualEntries: tx
      .select()
      .from(manualTimeEntries)
      .where(within(manualTimeEntries.sessionId, ids))
      .orderBy(manualTimeEntries.sessionId)
      .all(),
    billingRefs: tx
      .select()
      .from(sessionBillingRefs)
      .where(within(sessionBillingRefs.sessionId, ids))
      .orderBy(
        sessionBillingRefs.sessionId,
        sessionBillingRefs.stripeInvoiceId,
        sessionBillingRefs.testMode
      )
      .all(),
    invoices: shared.invoices,
    invoiceLineItems: shared.invoiceLineItems,
    reconciliationCases: shared.reconciliationCases.filter(
      (row) => files.has(row.sourceFile) || row.saved.some((entry) => mine(entry.id))
    ),
    reconciliationResolutions: shared.reconciliationResolutions.filter(
      (row) => files.has(row.sourceFile) || row.comparison.saved.some((entry) => mine(entry.id))
    )
  }
  const policyRevisionIds = new Set(
    tx
      .select({ id: sessionRevisions.id })
      .from(sessionRevisions)
      .where(
        and(
          within(
            sessionRevisions.id,
            replacements.map((row) => row.revisionId)
          ),
          eq(sessionRevisions.kind, 'policy')
        )
      )
      .all()
      .map((row) => row.id)
  )
  return { saved, mappedIds: new Set(mappingRows.map((row) => row.sessionId)), policyRevisionIds }
}

/**
 * All saved history is inventoried; comparable measurements are never apply authorization.
 * `conversationKeys` narrows the result and fingerprint to those conversations (scanner
 * continuation). It reads only those conversations' rows plus every row that can protect
 * them (see readScopedSaved), and a scoped fingerprint never matches a full review.
 */
export function previewWorkspaceHistory<TSchema extends Record<string, unknown>>(
  db: BetterSQLite3Database<TSchema>,
  candidate: unknown,
  conversationKeys?: readonly string[]
) {
  const scope = readScope(conversationKeys)
  return db.transaction((tx) => {
    const key = conversationKey
    const all = previewLedgerWorkspacePolicy(tx, candidate, conversationKeys)
    const ledger = scope
      ? {
          ...all,
          conversations: all.conversations.filter((row) =>
            scope.has(key(row.provider, row.conversationId))
          )
        }
      : all
    // Scoped: only the selected conversations' rows and every row that can protect them.
    const { saved, mappedIds, policyRevisionIds } = scope
      ? readScopedSaved(tx, scope, ledger.baseRevisionId)
      : readAllSaved(tx)
    const deleted = new Set(saved.deletions.map((row) => row.sessionId))
    const split = new Set(saved.splits.map((row) => row.parentSessionId))
    const replaced = new Set(saved.replacements.map((row) => row.predecessorSessionId))
    const disposition = (id: number): Comparison['disposition'] =>
      deleted.has(id)
        ? 'deleted'
        : split.has(id)
          ? 'split'
          : replaced.has(id)
            ? 'replaced'
            : 'active'
    const baselines = new Map(saved.derivations.map((row) => [row.sessionId, row]))
    const overrides = new Map(saved.timeOverrides.map((row) => [row.sessionId, row]))
    const mappings = new Map(saved.activityMappings.map((row) => [row.sessionId, row]))
    const groups = new Map<string, typeof saved.sessions>()
    for (const row of saved.sessions) {
      if (row.source !== 'auto' || !row.claudeSessionId) continue
      const id = key(row.tool, row.claudeSessionId)
      const group = groups.get(id) ?? []
      group.push(row)
      groups.set(id, group)
    }
    // Splits and deletions of adopted rows are ledger constraints (cuts and masks), so they
    // no longer protect their whole conversation. Every other operation still does.
    const protectedIds = new Set([
      ...saved.legacyRecords.map((row) => row.sessionId),
      ...saved.revisions.filter((row) => row.kind === 'reconcile').map((row) => row.sessionId),
      ...saved.reconciliationCases
        .filter((row) => !row.resolvedAt && !row.mappingReview)
        .flatMap((row) => row.saved.flatMap((entry) => (entry.id === undefined ? [] : [entry.id]))),
      ...saved.reconciliationResolutions.flatMap((row) =>
        row.comparison.saved.flatMap((entry) => (entry.id === undefined ? [] : [entry.id]))
      ),
      ...saved.splits
        .filter((row) => !isMappedHistorySplit(row, mappedIds))
        .flatMap((row) => [row.parentSessionId, row.firstSessionId, row.secondSessionId]),
      ...saved.replacements
        .filter((row) => !policyRevisionIds.has(row.revisionId))
        .flatMap((row) => [row.predecessorSessionId, row.successorSessionId]),
      ...saved.deletions
        .filter((row) => !isMappedHistoryDeletion(row, mappedIds))
        .map((row) => row.sessionId)
    ])
    const protectedSources = new Set([
      ...saved.reconciliationCases
        .filter((row) => !row.resolvedAt && !row.mappingReview)
        .map((row) => row.sourceFile),
      ...saved.reconciliationResolutions.map((row) => row.sourceFile)
    ])
    const indexes = new Map(
      ledger.conversations.map((row, index) => [key(row.provider, row.conversationId), index])
    )
    const groupReasons = new Map<string, ReviewReason>()
    for (const [id, group] of groups) {
      const conversation = ledger.conversations[indexes.get(id) ?? -1]
      if (!conversation || conversation.status !== 'resolved') continue
      const active = group.filter((row) => disposition(row.id) === 'active')
      if (
        group.some(
          (row) =>
            protectedIds.has(row.id) || (row.sourceFile && protectedSources.has(row.sourceFile))
        )
      ) {
        groupReasons.set(id, 'protected-history')
      } else if (
        conversation.operations &&
        (conversation.operations.invalid.length || conversation.operations.conflicts.before.length)
      ) {
        // Unreadable operations, or current work mixed with deleted coverage.
        groupReasons.set(id, 'history-operation-review')
      } else if (active.some((row) => !baselines.has(row.id))) {
        groupReasons.set(id, 'missing-baseline')
      } else if (active.some((row) => !validTimes(row) || !validTimes(baselines.get(row.id)!))) {
        groupReasons.set(id, 'invalid-saved-time')
      } else if (
        active.length !== conversation.before.length ||
        active.some((row) => {
          const baseline = baselines.get(row.id)!
          return (
            conversation.before.filter(
              (interval) =>
                sameBounds(baseline, interval) &&
                baseline.durationMinutes === interval.durationMinutes
            ).length !== 1
          )
        }) ||
        conversation.before.some(
          (interval) =>
            active.filter((row) => sameBounds(baselines.get(row.id)!, interval)).length !== 1
        )
      ) {
        groupReasons.set(id, 'baseline-coverage-mismatch')
      } else if (
        active.some((row) => {
          const interval = conversation.before.find((entry) =>
            sameBounds(baselines.get(row.id)!, entry)
          )!
          return (
            row.promptCount !== interval.promptCount ||
            row.inputTokens !== interval.inputTokens ||
            row.outputTokens !== interval.outputTokens ||
            usage(saved.modelUsage.filter((entry) => entry.sessionId === row.id)) !==
              usage(interval.modelUsage)
          )
        })
      ) {
        groupReasons.set(id, 'saved-measurements-differ')
      } else if (
        active.some((row) => {
          const mapping = mappings.get(row.id)
          if (!mapping) return false
          const interval = conversation.before.find((entry) =>
            sameBounds(baselines.get(row.id)!, entry)
          )!
          // Changed coverage, observations or policy require review, never rebinding.
          return (
            mapping.version !== 1 ||
            mapping.workspaceId !== ledger.workspaceId ||
            mapping.policyRevisionId !== ledger.baseRevisionId ||
            mapping.policyJson !== JSON.stringify(ledger.currentPolicy) ||
            mapping.provider !== conversation.provider ||
            mapping.conversationId !== conversation.conversationId ||
            !compatibleSnapshot(mapping.intervalJson, interval)
          )
        })
      ) {
        groupReasons.set(id, 'saved-activity-mapping-mismatch')
      }
    }
    const comparisons = saved.sessions.map((row): Comparison => {
      const id = key(row.tool, row.claudeSessionId)
      const conversationIndex = row.source === 'auto' ? (indexes.get(id) ?? null) : null
      const base = { sessionId: row.id, disposition: disposition(row.id), conversationIndex }
      const review = (reason: ReviewReason): Comparison => ({
        ...base,
        status: 'review-required',
        reason
      })
      if (base.disposition !== 'active')
        return { ...base, status: 'preserved', reason: 'audit-history' }
      if (row.source === 'manual') return { ...base, status: 'preserved', reason: 'manual-entry' }
      if (!row.claudeSessionId) return review('missing-conversation-id')
      if (conversationIndex === null) return review('missing-ledger-activity')
      const conversation = ledger.conversations[conversationIndex]
      if (conversation.status !== 'resolved') return review('unresolved-ledger-activity')
      const groupReason = groupReasons.get(id)
      if (groupReason) return review(groupReason)
      const baseline = baselines.get(row.id)!
      const beforeIndex = conversation.before.findIndex((entry) => sameBounds(baseline, entry))
      const afterIndices = conversation.transitions
        .filter((transition) =>
          transition.predecessors.some((predecessor) => predecessor.beforeIndex === beforeIndex)
        )
        .map((transition) => transition.afterIndex)
      if (
        afterIndices.length !== 1 ||
        conversation.transitions[afterIndices[0]].predecessors.length !== 1
      )
        return review('ambiguous-candidate-mapping')
      const afterIndex = afterIndices[0]
      const flags = overrides.get(row.id)
      const preservedTimeFields: Array<'startedAt' | 'endedAt' | 'durationMinutes'> = []
      const effectiveMeasurement = { ...conversation.after[afterIndex] }
      for (const field of ['startedAt', 'endedAt', 'durationMinutes'] as const) {
        const differs =
          field === 'durationMinutes'
            ? row[field] !== baseline[field]
            : Date.parse(row[field]) !== Date.parse(baseline[field])
        if (flags?.[field] || differs) {
          preservedTimeFields.push(field)
          if (field === 'durationMinutes') effectiveMeasurement[field] = row[field]
          else effectiveMeasurement[field] = row[field]
        }
      }
      if (
        !Number.isFinite(Date.parse(effectiveMeasurement.startedAt)) ||
        !Number.isFinite(Date.parse(effectiveMeasurement.endedAt)) ||
        Date.parse(effectiveMeasurement.startedAt) > Date.parse(effectiveMeasurement.endedAt) ||
        !Number.isFinite(effectiveMeasurement.durationMinutes) ||
        effectiveMeasurement.durationMinutes < 0
      )
        return review('invalid-preserved-time')
      return {
        ...base,
        status: 'comparable',
        mappingBasis: mappings.has(row.id) ? 'adopted-event-coverage' : 'measurement-only',
        mappingId: mappings.get(row.id)?.id ?? null,
        beforeIndex,
        afterIndex,
        preservedTimeFields,
        effectiveMeasurement
      }
    })
    const preview = {
      ...ledger,
      scope: 'saved-history-comparison' as const,
      application: 'unavailable' as const,
      conversationScope: scope ? [...scope].sort() : null,
      saved,
      comparisons,
      conversations: ledger.conversations.map((conversation) => ({
        ...conversation,
        savedSessionIds: (
          groups.get(key(conversation.provider, conversation.conversationId)) ?? []
        ).map((row) => row.id)
      }))
    }
    // Bind the actual retained facts too: unsupported/conflicting observations can
    // change without changing the unresolved reason or calculated session totals.
    // Scoped previews bind every retained fact of the selected conversations.
    const conversationIds = scope
      ? [...new Set([...scope].map((item) => (JSON.parse(item) as string[])[1]))]
      : []
    const facts = scope
      ? {
          identities: tx
            .select()
            .from(activityIdentities)
            .where(inArray(activityIdentities.conversationId, conversationIds))
            .orderBy(activityIdentities.eventId)
            .all()
            .filter((row) => scope.has(key(row.provider, row.conversationId))),
          observations: tx
            .select({
              id: activityObservations.id,
              eventId: activityObservations.eventId,
              version: activityObservations.version,
              kind: activityObservations.kind,
              payloadJson: activityObservations.payloadJson,
              provider: activityIdentities.provider,
              conversationId: activityIdentities.conversationId
            })
            .from(activityObservations)
            .innerJoin(
              activityIdentities,
              eq(activityIdentities.eventId, activityObservations.eventId)
            )
            .where(inArray(activityIdentities.conversationId, conversationIds))
            .orderBy(activityObservations.id)
            .all()
            .filter((row) => scope.has(key(row.provider, row.conversationId)))
            .map(({ id, eventId, version, kind, payloadJson }) => ({
              id,
              eventId,
              version,
              kind,
              payloadJson
            }))
        }
      : {
          identities: tx
            .select()
            .from(activityIdentities)
            .orderBy(activityIdentities.eventId)
            .all(),
          observations: tx
            .select({
              id: activityObservations.id,
              eventId: activityObservations.eventId,
              version: activityObservations.version,
              kind: activityObservations.kind,
              payloadJson: activityObservations.payloadJson
            })
            .from(activityObservations)
            .orderBy(activityObservations.id)
            .all()
        }
    const hash = createHash('sha256')
      .update(JSON.stringify({ version: 1, preview, facts }))
      .digest('hex')
    return { ...preview, fingerprint: `workspace-history-preview:v1:${hash}` }
  })
}

/** Recheck only, never apply approval. Future writes must recheck inside their own transaction. */
export function recheckWorkspaceHistoryPreview<TSchema extends Record<string, unknown>>(
  db: BetterSQLite3Database<TSchema>,
  candidate: unknown,
  expectedFingerprint: unknown,
  conversationKeys?: readonly string[]
) {
  const stale = () =>
    new AppError(
      'STALE_WORKSPACE_HISTORY_PREVIEW',
      'This comparison changed. Refresh and review the saved-history preview again.'
    )
  if (
    typeof expectedFingerprint !== 'string' ||
    !/^workspace-history-preview:v1:[a-f0-9]{64}$/.test(expectedFingerprint)
  )
    throw stale()
  const current = previewWorkspaceHistory(db, candidate, conversationKeys)
  if (current.fingerprint !== expectedFingerprint) throw stale()
  return current
}
