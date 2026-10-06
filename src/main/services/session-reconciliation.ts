import { createHash, randomUUID } from 'node:crypto'
import { and, desc, eq, inArray, isNull, or } from 'drizzle-orm'
import { getDb } from '../db'
import { sessions } from '../db/schema/sessions'
import { sessionDeletions, activeSessionCondition } from '../db/schema/session-deletions'
import { sessionDerivations, sessionTimeOverrides } from '../db/schema/session-derivations'
import { sessionSplits, sessionReplacements } from '../db/schema/session-history'
import { sessionModelUsage } from '../db/schema/session-model-usage'
import { sessionActivityMappings } from '../db/schema/session-activity-mappings'
import {
  sessionReconciliationCases,
  sessionReconciliationResolutions
} from '../db/schema/session-reconciliation'
import {
  SessionReconciliationError,
  recordSessionRevision,
  descendantSessionIds
} from './session-history'
import {
  retainLegacySession,
  adoptedLegacySessionsElsewhere,
  sourceLessLegacyDeletions,
  sourceLessLegacySessions
} from './session-legacy'
import { retainInvoiceBillingRefs } from './session-billing'
import { getWorkspacePolicy } from './workspace-policy'
import type { ParsedSessionData } from '../parsers/types'
import type {
  DetectedSession,
  ReconciliationPreview,
  SessionReconciliationCase,
  SessionActivityMapping,
  SessionReplacementChoice
} from '../../shared/types/session'

type Db = Pick<ReturnType<typeof getDb>, 'select' | 'insert' | 'update'>

const replacementFields = [
  'projectPath',
  'projectId',
  'clientId',
  'description',
  'billable',
  'status'
] as const
type SavedSession = typeof sessions.$inferSelect

function conflictingValues(rows: SavedSession[]): boolean {
  return rows.some((row) => replacementFields.some((key) => row[key] !== rows[0][key]))
}

function overlapsDetected(
  row: SavedSession,
  baseline: typeof sessionDerivations.$inferSelect | undefined,
  interval: DetectedSession
): boolean {
  if (!baseline || row.tool !== interval.tool || row.claudeSessionId !== interval.claudeSessionId)
    return false
  const a = Date.parse(baseline.startedAt)
  const b = Date.parse(baseline.endedAt)
  const start = Date.parse(interval.startedAt)
  const end = Date.parse(interval.endedAt)
  return (
    a === start ||
    (a < end && start < b) ||
    (start === end && start >= a && start <= b) ||
    (a === b && a >= start && a <= end)
  )
}

/** Include source-less history whose known conversation matches returning activity. */
function savedHistoryRows(
  db: Db,
  sourceFile: string,
  detected: DetectedSession[],
  activeOnly = false
) {
  const relatedIds = [
    ...descendantSessionIds(db, [
      ...adoptedLegacySessionsElsewhere(db, sourceFile, detected).map((row) => row.id),
      ...sourceLessLegacyDeletions(db, detected).map((row) => row.sessionId),
      ...sourceLessLegacySessions(db, detected).map((row) => row.id)
    ])
  ]
  return db
    .select()
    .from(sessions)
    .where(
      and(
        eq(sessions.source, 'auto'),
        or(
          eq(sessions.sourceFile, sourceFile),
          relatedIds.length ? inArray(sessions.id, relatedIds) : undefined
        ),
        activeOnly ? activeSessionCondition : undefined
      )
    )
    .orderBy(sessions.id)
    .all()
}

/** Bind an approval to retained facts, measurements, current saved values and edit intent. */
export function reconciliationFingerprint(
  db: Db,
  sourceFile: string,
  detected: DetectedSession[],
  idleTimeoutMinutes: number,
  activity?: ParsedSessionData
): string {
  const workspace = getWorkspacePolicy(db)
  const rows = savedHistoryRows(db, sourceFile, detected)
  const replacements = rows.length
    ? db
        .select()
        .from(sessionReplacements)
        .where(
          inArray(
            sessionReplacements.predecessorSessionId,
            rows.map((row) => row.id)
          )
        )
        .orderBy(sessionReplacements.predecessorSessionId, sessionReplacements.successorSessionId)
        .all()
    : []
  const saved = rows.map((row) => ({
    row,
    baseline:
      db.select().from(sessionDerivations).where(eq(sessionDerivations.sessionId, row.id)).get() ??
      null,
    overrides:
      db
        .select()
        .from(sessionTimeOverrides)
        .where(eq(sessionTimeOverrides.sessionId, row.id))
        .get() ?? null,
    usage: db
      .select()
      .from(sessionModelUsage)
      .where(eq(sessionModelUsage.sessionId, row.id))
      .orderBy(sessionModelUsage.model)
      .all(),
    deletion:
      db.select().from(sessionDeletions).where(eq(sessionDeletions.sessionId, row.id)).get() ??
      null,
    split:
      db.select().from(sessionSplits).where(eq(sessionSplits.parentSessionId, row.id)).get() ?? null
  }))
  return createHash('sha256')
    .update(
      JSON.stringify({
        version: 1,
        sourceFile,
        saved,
        ...(replacements.length ? { replacements } : {}),
        detected,
        idleTimeoutMinutes,
        timezone:
          workspace?.policy.reportingTimeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
        ...(workspace ? { workspace } : {}),
        activity: activity ?? null
      })
    )
    .digest('hex')
}

const mappingNote = '\n\nActivity mapping review: '

/** Any adopted mapping makes a conversation mapping-managed, including its copies on other sources. */
function mappingManaged(
  db: Db,
  rows: Array<{ tool: string; claudeSessionId: string | null }>
): boolean {
  const keys = new Set(
    rows.flatMap((row) =>
      row.claudeSessionId ? [JSON.stringify([row.tool, row.claudeSessionId])] : []
    )
  )
  if (!keys.size) return false
  const conversationIds = [
    ...new Set(rows.flatMap((row) => (row.claudeSessionId ? [row.claudeSessionId] : [])))
  ]
  return db
    .select({
      provider: sessionActivityMappings.provider,
      conversationId: sessionActivityMappings.conversationId
    })
    .from(sessionActivityMappings)
    .where(inArray(sessionActivityMappings.conversationId, conversationIds))
    .all()
    .some((row) => keys.has(JSON.stringify([row.provider, row.conversationId])))
}

/**
 * Legacy keep/map/replace would bypass mapping revisions or turn a transient mapping hold
 * into permanent protection. Checked in the service layer so stale or direct requests fail.
 */
function assertLegacyResolutionAllowed(
  db: Db,
  sourceFile: string,
  detected: DetectedSession[]
): void {
  const review = db
    .select()
    .from(sessionReconciliationCases)
    .where(eq(sessionReconciliationCases.sourceFile, sourceFile))
    .get()
  if (
    (review && !review.resolvedAt && review.mappingReview) ||
    mappingManaged(db, [...detected, ...savedHistoryRows(db, sourceFile, detected)])
  )
    throw new Error(
      'This history is managed by reviewed activity mappings. Recheck retained activity, or review the shared tracking policy in Settings. Saved history was retained.'
    )
}

function latestResolution(db: Db, sourceFile: string) {
  return db
    .select()
    .from(sessionReconciliationResolutions)
    .where(eq(sessionReconciliationResolutions.sourceFile, sourceFile))
    .orderBy(desc(sessionReconciliationResolutions.sequence))
    .get()
}

/** A prior keep decision cannot silently turn into permission to replace growing history. */
export function retainedResolutionCount(
  db: Db,
  sourceFile: string,
  detected: DetectedSession[],
  idleTimeoutMinutes: number,
  activity?: ParsedSessionData
): number | null {
  const resolution = latestResolution(db, sourceFile)
  if (!resolution || resolution.action !== 'keep_saved') return null
  if (
    resolution.fingerprint !==
    reconciliationFingerprint(db, sourceFile, detected, idleTimeoutMinutes, activity)
  ) {
    throw new SessionReconciliationError(
      'Activity, saved history or policy changed since the keep-saved decision. Review this source again; saved history was retained.'
    )
  }
  return db
    .select({ id: sessions.id })
    .from(sessions)
    .where(
      and(eq(sessions.sourceFile, sourceFile), eq(sessions.source, 'auto'), activeSessionCondition)
    )
    .all().length
}

/** Caller supplies a synchronous transaction and a freshly reconstructed comparison. */
export function keepSavedHistory(
  db: Db,
  sourceFile: string,
  expectedFingerprint: string,
  detected: DetectedSession[],
  idleTimeoutMinutes: number,
  activity?: ParsedSessionData
): void {
  assertLegacyResolutionAllowed(db, sourceFile, detected)
  const current = reconciliationFingerprint(db, sourceFile, detected, idleTimeoutMinutes, activity)
  if (!expectedFingerprint || current !== expectedFingerprint)
    throw new Error(
      'This comparison changed. Recheck retained activity and review the updated values before confirming.'
    )
  const previous = latestResolution(db, sourceFile)
  const review = db
    .select()
    .from(sessionReconciliationCases)
    .where(eq(sessionReconciliationCases.sourceFile, sourceFile))
    .get()
  if (previous?.fingerprint === current && review?.resolvedAt) return
  if (!review || review.resolvedAt || review.fingerprint !== current)
    throw new Error(
      'This comparison is no longer pending. Recheck retained activity before confirming.'
    )
  db.insert(sessionReconciliationResolutions)
    .values({
      id: randomUUID(),
      sourceFile,
      sequence: (previous?.sequence ?? 0) + 1,
      parentId: previous?.id ?? null,
      action: 'keep_saved',
      fingerprint: current,
      comparison: review,
      createdAt: new Date().toISOString()
    })
    .run()
  resolveReconciliationCase(db, sourceFile)
}

/** Caller owns the transaction. Preserve saved time/edits and adopt only measured activity. */
export function mapSavedHistory(
  db: Db & Pick<ReturnType<typeof getDb>, 'delete'>,
  sourceFile: string,
  expectedFingerprint: string,
  mappings: SessionActivityMapping[],
  detected: DetectedSession[],
  idleTimeoutMinutes: number,
  activity?: ParsedSessionData
): void {
  assertLegacyResolutionAllowed(db, sourceFile, detected)
  const current = reconciliationFingerprint(db, sourceFile, detected, idleTimeoutMinutes, activity)
  if (!expectedFingerprint || current !== expectedFingerprint)
    throw new Error(
      'This comparison changed. Recheck retained activity before confirming a mapping.'
    )
  const review = db
    .select()
    .from(sessionReconciliationCases)
    .where(eq(sessionReconciliationCases.sourceFile, sourceFile))
    .get()
  if (!review || review.resolvedAt || review.fingerprint !== current)
    throw new Error(
      'This comparison is no longer pending. Recheck retained activity before confirming.'
    )
  if (adoptedLegacySessionsElsewhere(db, sourceFile, detected).length)
    throw new Error(
      'This legacy history is already linked to another source. Keep saved history or leave this review pending.'
    )
  const rows = savedHistoryRows(db, sourceFile, detected, true)
  const rowIds = rows.map((row) => row.id)
  if (
    db
      .select()
      .from(sessionSplits)
      .where(
        or(
          eq(sessionSplits.sourceFile, sourceFile),
          rowIds.length ? inArray(sessionSplits.firstSessionId, rowIds) : undefined,
          rowIds.length ? inArray(sessionSplits.secondSessionId, rowIds) : undefined
        )
      )
      .get() ||
    db.select().from(sessionDeletions).where(eq(sessionDeletions.sourceFile, sourceFile)).get() ||
    sourceLessLegacyDeletions(db, detected).length > 0
  )
    throw new Error(
      'Sources with splits or deletions cannot use a one-to-one mapping. Keep saved history or leave this review pending.'
    )
  if (
    !Array.isArray(mappings) ||
    !detected.length ||
    rows.length !== detected.length ||
    mappings.length !== detected.length ||
    new Set(mappings.map((mapping) => mapping.sessionId)).size !== rows.length ||
    new Set(mappings.map((mapping) => mapping.detectedIndex)).size !== detected.length ||
    mappings.some(
      (mapping) =>
        !rows.some((row) => row.id === mapping.sessionId) ||
        !Number.isInteger(mapping.detectedIndex) ||
        mapping.detectedIndex < 0 ||
        mapping.detectedIndex >= detected.length
    )
  )
    throw new Error(
      'Map every detected interval to a different saved session. Split/merge mappings are not available yet.'
    )
  // Validate every pairing before changing any saved measurement.
  for (const mapping of mappings) {
    const row = rows.find((row) => row.id === mapping.sessionId)!
    const incoming = detected[mapping.detectedIndex]
    if (
      row.tool !== incoming.tool ||
      (row.claudeSessionId && row.claudeSessionId !== incoming.claudeSessionId)
    )
      throw new Error('A mapping must preserve the provider and known conversation identity.')
  }
  for (const mapping of mappings) {
    const row = rows.find((row) => row.id === mapping.sessionId)!
    const incoming = detected[mapping.detectedIndex]
    const baseline = db
      .select()
      .from(sessionDerivations)
      .where(eq(sessionDerivations.sessionId, row.id))
      .get()
    const oldOverrides = db
      .select()
      .from(sessionTimeOverrides)
      .where(eq(sessionTimeOverrides.sessionId, row.id))
      .get()
    const usage = db
      .select()
      .from(sessionModelUsage)
      .where(eq(sessionModelUsage.sessionId, row.id))
      .all()
    if (!baseline) retainLegacySession(db, row)
    const measured = {
      startedAt: incoming.startedAt,
      endedAt: incoming.endedAt,
      durationMinutes: incoming.durationMinutes
    }
    const overrides = {
      startedAt:
        oldOverrides?.startedAt ||
        Number(
          (baseline && row.startedAt !== baseline.startedAt) || row.startedAt !== measured.startedAt
        ),
      endedAt:
        oldOverrides?.endedAt ||
        Number((baseline && row.endedAt !== baseline.endedAt) || row.endedAt !== measured.endedAt),
      durationMinutes:
        oldOverrides?.durationMinutes ||
        Number(
          (baseline && row.durationMinutes !== baseline.durationMinutes) ||
            row.durationMinutes !== measured.durationMinutes
        )
    }
    const updates = {
      sourceFile,
      claudeSessionId: incoming.claudeSessionId,
      promptCount: incoming.promptCount,
      inputTokens: incoming.inputTokens,
      outputTokens: incoming.outputTokens,
      updatedAt: new Date().toISOString()
    }
    recordSessionRevision(
      db,
      row,
      'reconcile',
      { session: row, baseline, overrides: oldOverrides, modelUsage: usage },
      {
        session: { ...row, ...updates },
        baseline: measured,
        overrides,
        modelUsage: incoming.modelUsage,
        mapping,
        ...(!row.sourceFile ? { assignmentOverride: true } : {})
      }
    )
    db.update(sessions).set(updates).where(eq(sessions.id, row.id)).run()
    db.insert(sessionDerivations)
      .values({ sessionId: row.id, ...measured })
      .onConflictDoUpdate({ target: sessionDerivations.sessionId, set: measured })
      .run()
    db.insert(sessionTimeOverrides)
      .values({ sessionId: row.id, ...overrides })
      .onConflictDoUpdate({ target: sessionTimeOverrides.sessionId, set: overrides })
      .run()
    db.delete(sessionModelUsage).where(eq(sessionModelUsage.sessionId, row.id)).run()
    if (incoming.modelUsage.length)
      db.insert(sessionModelUsage)
        .values(incoming.modelUsage.map((usage) => ({ sessionId: row.id, ...usage })))
        .run()
  }
  const previous = latestResolution(db, sourceFile)
  db.insert(sessionReconciliationResolutions)
    .values({
      id: randomUUID(),
      sourceFile,
      sequence: (previous?.sequence ?? 0) + 1,
      parentId: previous?.id ?? null,
      action: 'map_saved',
      fingerprint: current,
      comparison: { ...review, mappings },
      createdAt: new Date().toISOString()
    })
    .run()
  resolveReconciliationCase(db, sourceFile)
}

/** Approve measured split/merge boundaries only where saved edits can be carried unambiguously. */
export function replaceSavedHistory(
  db: Db & Pick<ReturnType<typeof getDb>, 'delete'>,
  sourceFile: string,
  expectedFingerprint: string,
  detected: DetectedSession[],
  idleTimeoutMinutes: number,
  activity?: ParsedSessionData,
  choices: SessionReplacementChoice[] = []
): void {
  assertLegacyResolutionAllowed(db, sourceFile, detected)
  const current = reconciliationFingerprint(db, sourceFile, detected, idleTimeoutMinutes, activity)
  if (!expectedFingerprint || expectedFingerprint !== current)
    throw new Error(
      'This comparison changed. Recheck retained activity before confirming replacement.'
    )
  const review = db
    .select()
    .from(sessionReconciliationCases)
    .where(eq(sessionReconciliationCases.sourceFile, sourceFile))
    .get()
  if (!review || review.resolvedAt || review.fingerprint !== current)
    throw new Error(
      'This comparison is no longer pending. Recheck retained activity before confirming.'
    )
  if (adoptedLegacySessionsElsewhere(db, sourceFile, detected).length)
    throw new Error(
      'This legacy history is already linked to another source. Keep saved history or leave this review pending.'
    )
  if (sourceLessLegacySessions(db, detected).length)
    throw new Error(
      'Source-less legacy history needs an explicit activity mapping before replacement.'
    )
  if (
    db.select().from(sessionSplits).where(eq(sessionSplits.sourceFile, sourceFile)).get() ||
    db.select().from(sessionDeletions).where(eq(sessionDeletions.sourceFile, sourceFile)).get() ||
    sourceLessLegacyDeletions(db, detected).length
  )
    throw new Error(
      'Sources with explicit splits or deletions need a separate resolution. Saved history was retained.'
    )
  const rows = db
    .select()
    .from(sessions)
    .where(
      and(eq(sessions.sourceFile, sourceFile), eq(sessions.source, 'auto'), activeSessionCondition)
    )
    .orderBy(sessions.id)
    .all()
  if (!rows.length || !detected.length)
    throw new Error('Replacement requires both saved history and detected activity.')
  if (
    !Array.isArray(choices) ||
    choices.some(
      (choice) =>
        !choice ||
        !Number.isInteger(choice.detectedIndex) ||
        choice.detectedIndex < 0 ||
        choice.detectedIndex >= detected.length ||
        !Number.isSafeInteger(choice.sessionId)
    ) ||
    new Set(choices.map((choice) => choice.detectedIndex)).size !== choices.length
  )
    throw new Error('Choose at most one saved session for each detected interval.')
  const predecessors = rows.map((row) => {
    const baseline = db
      .select()
      .from(sessionDerivations)
      .where(eq(sessionDerivations.sessionId, row.id))
      .get()
    const overrides = db
      .select()
      .from(sessionTimeOverrides)
      .where(eq(sessionTimeOverrides.sessionId, row.id))
      .get()
    if (!baseline)
      throw new Error(
        'Legacy times need an explicit mapping. Keep saved history or leave this review pending.'
      )
    const timeOverrides = {
      startedAt:
        overrides?.startedAt ||
        Number(Date.parse(row.startedAt) !== Date.parse(baseline.startedAt)),
      endedAt:
        overrides?.endedAt || Number(Date.parse(row.endedAt) !== Date.parse(baseline.endedAt)),
      durationMinutes:
        overrides?.durationMinutes || Number(row.durationMinutes !== baseline.durationMinutes)
    }
    const modelUsage = db
      .select()
      .from(sessionModelUsage)
      .where(eq(sessionModelUsage.sessionId, row.id))
      .all()
    return { row, baseline, overrides, timeOverrides, modelUsage }
  })
  const plan = detected.map((interval, detectedIndex) => {
    const parents = predecessors.filter(({ row, baseline }) =>
      overlapsDetected(row, baseline, interval)
    )
    if (!parents.length)
      throw new Error(
        'Some detected activity has no saved predecessor. Leave this comparison pending for explicit mapping.'
      )
    const edited = parents.some((parent) => Object.values(parent.timeOverrides).some(Boolean))
    if (
      edited &&
      (parents.length !== 1 ||
        detected.filter((candidate) =>
          overlapsDetected(parents[0].row, parents[0].baseline, candidate)
        ).length !== 1)
    )
      throw new Error(
        'Edited times cannot be split or merged automatically. Keep saved history or leave this review pending.'
      )
    const timeOverrides = parents[0].timeOverrides
    const times = {
      startedAt: timeOverrides.startedAt ? parents[0].row.startedAt : interval.startedAt,
      endedAt: timeOverrides.endedAt ? parents[0].row.endedAt : interval.endedAt,
      durationMinutes: timeOverrides.durationMinutes
        ? parents[0].row.durationMinutes
        : interval.durationMinutes
    }
    if (
      !Number.isFinite(Date.parse(times.startedAt)) ||
      !Number.isFinite(Date.parse(times.endedAt)) ||
      Date.parse(times.startedAt) > Date.parse(times.endedAt) ||
      !Number.isFinite(times.durationMinutes) ||
      times.durationMinutes < 0
    )
      throw new Error(
        'Preserving saved edits would produce an invalid time range. Keep saved history or map its activity explicitly.'
      )
    const choice = choices.find((item) => item.detectedIndex === detectedIndex)
    const selected = choice && parents.find(({ row }) => row.id === choice.sessionId)
    if (choice && !selected)
      throw new Error('Choose values from a saved session overlapping that detected interval.')
    if (!choice && conflictingValues(parents.map(({ row }) => row)))
      throw new Error(
        'Choose a saved session for each detected interval with conflicting assignments, descriptions or billable choices. Recheck retained activity if choices are unavailable. Saved history was retained.'
      )
    const first = selected ? selected.row : parents[0].row
    return { interval, parents, first, choice, times, timeOverrides }
  })
  if (predecessors.some((parent) => !plan.some((item) => item.parents.includes(parent))))
    throw new Error('Some saved history has no detected successor. Saved history was retained.')

  retainInvoiceBillingRefs(db)
  const successors = plan.map(({ interval, first, parents, choice, times, timeOverrides }) => {
    const { modelUsage, ...activityFields } = interval
    const values = {
      ...activityFields,
      ...times,
      source: 'auto',
      projectPath: first.projectPath,
      projectId: first.projectId,
      clientId: first.clientId,
      description: first.description,
      billable: first.billable,
      status: first.status
    } as const
    const measured = {
      startedAt: interval.startedAt,
      endedAt: interval.endedAt,
      durationMinutes: interval.durationMinutes
    }
    const keepId =
      parents.length === 1 &&
      plan.filter((item) => item.parents.includes(parents[0])).length === 1 &&
      Date.parse(parents[0].baseline.startedAt) === Date.parse(interval.startedAt)
    const row = keepId ? first : db.insert(sessions).values(values).returning().get()
    if (keepId) {
      recordSessionRevision(db, first, 'reconcile', parents[0], {
        session: { ...first, ...values },
        baseline: measured,
        overrides: timeOverrides,
        modelUsage
      })
      db.update(sessions)
        .set({ ...values, updatedAt: new Date().toISOString() })
        .where(eq(sessions.id, first.id))
        .run()
      db.delete(sessionModelUsage).where(eq(sessionModelUsage.sessionId, first.id)).run()
    }
    db.insert(sessionDerivations)
      .values({ sessionId: row.id, ...measured })
      .onConflictDoUpdate({ target: sessionDerivations.sessionId, set: measured })
      .run()
    db.insert(sessionTimeOverrides)
      .values({ sessionId: row.id, ...timeOverrides })
      .onConflictDoUpdate({ target: sessionTimeOverrides.sessionId, set: timeOverrides })
      .run()
    if (modelUsage.length)
      db.insert(sessionModelUsage)
        .values(modelUsage.map((usage) => ({ sessionId: row.id, ...usage })))
        .run()
    if (choice)
      recordSessionRevision(
        db,
        row,
        'reconcile',
        { projectId: row.projectId, clientId: row.clientId },
        {
          assignmentOverride: true,
          choice,
          projectId: values.projectId,
          clientId: values.clientId
        }
      )
    return row
  })
  for (const parent of predecessors) {
    const children = successors.filter((_, index) => plan[index].parents.includes(parent))
    if (children.length === 1 && children[0].id === parent.row.id) continue
    const revisionId = recordSessionRevision(
      db,
      parent.row,
      'reconcile',
      {
        session: parent.row,
        baseline: parent.baseline,
        overrides: parent.overrides,
        modelUsage: parent.modelUsage
      },
      { replacement: true, successors: children }
    )
    db.insert(sessionReplacements)
      .values(
        children.map((child) => ({
          predecessorSessionId: parent.row.id,
          successorSessionId: child.id,
          revisionId
        }))
      )
      .run()
  }
  const previous = latestResolution(db, sourceFile)
  db.insert(sessionReconciliationResolutions)
    .values({
      id: randomUUID(),
      sourceFile,
      sequence: (previous?.sequence ?? 0) + 1,
      parentId: previous?.id ?? null,
      action: 'replace_saved',
      fingerprint: current,
      comparison: { ...review, choices },
      createdAt: new Date().toISOString()
    })
    .run()
  resolveReconciliationCase(db, sourceFile)
}

function measurement(row: DetectedSession | typeof sessions.$inferSelect) {
  return {
    projectPath: row.projectPath,
    startedAt: row.startedAt,
    endedAt: row.endedAt,
    durationMinutes: row.durationMinutes,
    promptCount: row.promptCount,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens
  }
}

/** Called after the source transaction rolls back, so saved previews describe retained history. */
export function recordReconciliationFailure(
  db: Db,
  sourceFile: string,
  message: string,
  detected: DetectedSession[],
  idleTimeoutMinutes: number,
  activity?: ParsedSessionData,
  mappingReview = false
): void {
  const savedRows = savedHistoryRows(db, sourceFile, detected)
  const saved: ReconciliationPreview[] = savedRows.map((row) => ({
    ...measurement(row),
    id: row.id,
    sourceFile: row.sourceFile,
    clientId: row.clientId,
    projectId: row.projectId,
    description: row.description,
    billable: !!row.billable,
    status: row.status,
    disposition: db
      .select()
      .from(sessionDeletions)
      .where(eq(sessionDeletions.sessionId, row.id))
      .get()
      ? 'deleted'
      : db.select().from(sessionSplits).where(eq(sessionSplits.parentSessionId, row.id)).get()
        ? 'split'
        : db
              .select()
              .from(sessionReplacements)
              .where(eq(sessionReplacements.predecessorSessionId, row.id))
              .get()
          ? 'replaced'
          : 'active',
    modelUsage: db
      .select({
        model: sessionModelUsage.model,
        inputTokens: sessionModelUsage.inputTokens,
        outputTokens: sessionModelUsage.outputTokens,
        cacheCreationInputTokens: sessionModelUsage.cacheCreationInputTokens,
        cacheReadInputTokens: sessionModelUsage.cacheReadInputTokens
      })
      .from(sessionModelUsage)
      .where(eq(sessionModelUsage.sessionId, row.id))
      .orderBy(sessionModelUsage.model)
      .all()
  }))
  const activeIds = new Set(
    saved.filter((row) => row.disposition === 'active').map((row) => row.id)
  )
  const predecessors = savedRows
    .filter((row) => activeIds.has(row.id))
    .map((row) => ({
      row,
      baseline: db
        .select()
        .from(sessionDerivations)
        .where(eq(sessionDerivations.sessionId, row.id))
        .get()
    }))
  const now = new Date().toISOString()
  const existing = db
    .select()
    .from(sessionReconciliationCases)
    .where(eq(sessionReconciliationCases.sourceFile, sourceFile))
    .get()
  // A transient mapping failure never lowers an unresolved legacy case's protection or hides
  // its discrepancy. A resolved case may become a new mapping case.
  const legacyMessage =
    existing && !existing.resolvedAt && !existing.mappingReview
      ? existing.message.split(mappingNote)[0]
      : null
  const comparison = {
    mappingReview: legacyMessage === null ? Number(mappingReview) : 0,
    fingerprint: reconciliationFingerprint(db, sourceFile, detected, idleTimeoutMinutes, activity),
    message:
      legacyMessage !== null && mappingReview
        ? `${legacyMessage}${mappingNote}${message}`
        : message,
    saved,
    idleTimeoutMinutes,
    updatedAt: now,
    resolvedAt: null,
    detected: detected.map((row): ReconciliationPreview => {
      const candidates = predecessors
        .filter((parent) => overlapsDetected(parent.row, parent.baseline, row))
        .map((parent) => parent.row)
      return {
        ...measurement(row),
        disposition: 'detected',
        tool: row.tool,
        claudeSessionId: row.claudeSessionId,
        clientId: null,
        projectId: null,
        modelUsage: row.modelUsage ?? [],
        replacementCandidates: candidates.map((parent) => parent.id),
        requiresReplacementChoice: conflictingValues(candidates)
      }
    })
  }
  db.insert(sessionReconciliationCases)
    .values({ sourceFile, createdAt: now, ...comparison })
    .onConflictDoUpdate({ target: sessionReconciliationCases.sourceFile, set: comparison })
    .run()
}

/** Must commit together with the successful source reconciliation. */
export function resolveReconciliationCase(db: Db, sourceFile: string): void {
  db.update(sessionReconciliationCases)
    .set({ resolvedAt: new Date().toISOString() })
    .where(
      and(
        eq(sessionReconciliationCases.sourceFile, sourceFile),
        isNull(sessionReconciliationCases.resolvedAt)
      )
    )
    .run()
}

export function getReconciliationCases(): SessionReconciliationCase[] {
  const db = getDb()
  return db
    .select()
    .from(sessionReconciliationCases)
    .where(isNull(sessionReconciliationCases.resolvedAt))
    .orderBy(sessionReconciliationCases.createdAt, sessionReconciliationCases.sourceFile)
    .all()
    .map((review) => {
      const ids = review.saved.flatMap((row) => (row.id === undefined ? [] : [row.id]))
      // Older snapshots lack detected identities; the legacy actions recheck current activity.
      const rows = [
        ...savedHistoryRows(db, review.sourceFile, []),
        ...(ids.length ? db.select().from(sessions).where(inArray(sessions.id, ids)).all() : []),
        ...review.detected.flatMap((row) =>
          row.tool ? [{ tool: row.tool, claudeSessionId: row.claudeSessionId ?? null }] : []
        )
      ]
      return { ...review, mappingManaged: !!review.mappingReview || mappingManaged(db, rows) }
    })
}
