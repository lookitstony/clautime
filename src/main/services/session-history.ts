import { randomUUID } from 'node:crypto'
import { desc, eq, or, sql } from 'drizzle-orm'
import type { getDb } from '../db'
import type { Session } from '../db/schema/sessions'
import { sessionDerivations } from '../db/schema/session-derivations'
import { sessionRevisions, sessionSplits, sessionReplacements } from '../db/schema/session-history'
import type { DetectedSession } from '../../shared/types/session'

type HistoryTransaction = Pick<ReturnType<typeof getDb>, 'select' | 'insert'>

/** Explicit reconciliation assignments, including nulls, stay fixed through their descendants. */
export function explicitAssignmentSessionIds(db: Pick<HistoryTransaction, 'select'>): Set<number> {
  const ids = new Set(
    db
      .select({ id: sessionRevisions.sessionId })
      .from(sessionRevisions)
      .where(sql`json_extract(${sessionRevisions.after}, '$.assignmentOverride') = 1`)
      .all()
      .map((row) => row.id)
  )
  return descendantSessionIds(db, ids)
}

/** Include the supplied sessions and every descendant through splits and replacements. */
export function descendantSessionIds(
  db: Pick<HistoryTransaction, 'select'>,
  sessionIds: Iterable<number>
): Set<number> {
  const ids = new Set(sessionIds)
  if (!ids.size) return ids
  const children = new Map<number, number[]>()
  const add = (parent: number, child: number): void => {
    const list = children.get(parent) ?? []
    list.push(child)
    children.set(parent, list)
  }
  for (const edge of db.select().from(sessionReplacements).all())
    add(edge.predecessorSessionId, edge.successorSessionId)
  for (const split of db.select().from(sessionSplits).all()) {
    add(split.parentSessionId, split.firstSessionId)
    add(split.parentSessionId, split.secondSessionId)
  }
  // Set iteration visits newly discovered descendants once, even through merge diamonds.
  for (const id of ids) for (const child of children.get(id) ?? []) ids.add(child)
  return ids
}

export function recordSessionRevision(
  tx: HistoryTransaction,
  session: Session,
  kind: 'edit' | 'split' | 'reconcile',
  before: unknown,
  after: unknown
): string {
  const previous = tx
    .select()
    .from(sessionRevisions)
    .where(eq(sessionRevisions.sessionId, session.id))
    .orderBy(desc(sessionRevisions.sequence))
    .get()
  const origin = previous
    ? undefined
    : tx
        .select()
        .from(sessionSplits)
        .where(
          or(
            eq(sessionSplits.firstSessionId, session.id),
            eq(sessionSplits.secondSessionId, session.id)
          )
        )
        .get()
  const baseline =
    session.source === 'manual'
      ? session
      : tx
          .select()
          .from(sessionDerivations)
          .where(eq(sessionDerivations.sessionId, session.id))
          .get()
  const id = randomUUID()
  tx.insert(sessionRevisions)
    .values({
      id,
      sessionId: session.id,
      sequence: (previous?.sequence ?? 0) + 1,
      parentRevisionId: previous?.id ?? origin?.revisionId ?? null,
      kind,
      sourceFile: session.sourceFile,
      tool: session.tool,
      claudeSessionId: session.claudeSessionId,
      startedAt: baseline?.startedAt ?? null,
      endedAt: baseline?.endedAt ?? null,
      before: JSON.stringify(before),
      after: JSON.stringify(after),
      createdAt: new Date().toISOString()
    })
    .run()
  return id
}

/** Preserve the existing proportional allocation, with exact conservation of totals. */
export function splitMeasurement(
  d: DetectedSession,
  splitAt: string
): [DetectedSession, DetectedSession] {
  const start = Date.parse(d.startedAt)
  const end = Date.parse(d.endedAt)
  const cut = Date.parse(splitAt)
  if (![start, end, cut].every(Number.isFinite) || cut <= start || cut >= end) {
    throw new Error('Split point must be between session start and end')
  }
  const ratio = (cut - start) / (end - start)
  const first = { ...d, endedAt: splitAt }
  const second = { ...d, startedAt: splitAt }
  for (const key of ['durationMinutes', 'promptCount', 'inputTokens', 'outputTokens'] as const) {
    first[key] = Math.round(d[key] * ratio)
    second[key] = d[key] - first[key]
  }
  first.modelUsage = []
  second.modelUsage = []
  for (const usage of d.modelUsage ?? []) {
    const a = { ...usage }
    const b = { ...usage }
    for (const key of [
      'inputTokens',
      'outputTokens',
      'cacheCreationInputTokens',
      'cacheReadInputTokens'
    ] as const) {
      a[key] = Math.round(usage[key] * ratio)
      b[key] = usage[key] - a[key]
    }
    first.modelUsage.push(a)
    second.modelUsage.push(b)
  }
  return [first, second]
}

export class SessionReconciliationError extends Error {}

type MappedSession = DetectedSession & { localSessionId?: number }

/** Replay explicit split revisions before ordinary one-to-one reconciliation. */
export function applySessionSplits(
  tx: HistoryTransaction,
  sourceFile: string,
  detected: DetectedSession[]
): MappedSession[] {
  const splits = tx
    .select()
    .from(sessionSplits)
    .where(eq(sessionSplits.sourceFile, sourceFile))
    .all()
  if (!splits.length) return detected
  if (splits.some((split) => split.legacyRecordId)) {
    throw new SessionReconciliationError(
      `Session reconciliation needs review for ${sourceFile}. Returned activity cannot be mapped safely to a legacy split; saved history was retained.`
    )
  }
  const children = new Set(splits.flatMap((s) => [s.firstSessionId, s.secondSessionId]))
  const roots = splits.filter((s) => !children.has(s.parentSessionId))
  const byParent = new Map(splits.map((s) => [s.parentSessionId, s]))
  const matched = new Set<number>()
  const fail = (): never => {
    throw new SessionReconciliationError(
      `Session reconciliation needs review for ${sourceFile}. Changed boundaries cannot preserve an explicit split; saved history was retained.`
    )
  }
  const expand = (d: DetectedSession, id: number): MappedSession[] => {
    const split = byParent.get(id)
    if (!split) return [{ ...d, localSessionId: id }]
    if (
      Date.parse(split.splitAt) <= Date.parse(d.startedAt) ||
      Date.parse(split.splitAt) >= Date.parse(d.endedAt)
    )
      return fail()
    const [first, second] = splitMeasurement(d, split.splitAt)
    return [...expand(first, split.firstSessionId), ...expand(second, split.secondSessionId)]
  }
  const result = detected.flatMap((d): MappedSession[] => {
    const root = roots.find(
      (s) =>
        s.tool === d.tool &&
        s.claudeSessionId === d.claudeSessionId &&
        Date.parse(s.startedAt) === Date.parse(d.startedAt)
    )
    if (!root) return [d]
    if (matched.has(root.parentSessionId)) return fail()
    matched.add(root.parentSessionId)
    return expand(d, root.parentSessionId)
  })
  if (matched.size !== roots.length) return fail()
  return result
}
