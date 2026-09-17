import { randomUUID } from 'node:crypto'
import { and, eq, isNotNull, isNull, ne, or, sql } from 'drizzle-orm'
import type { getDb } from '../db'
import { sessions, type Session } from '../db/schema/sessions'
import { sessionLegacyRecords } from '../db/schema/session-legacy'
import { sessionModelUsage } from '../db/schema/session-model-usage'
import { sessionDeletions, activeSessionCondition } from '../db/schema/session-deletions'
import { sessionDerivations } from '../db/schema/session-derivations'
import type { DetectedSession } from '../../shared/types/session'

/** Adopting one log does not approve other logs that matched the original legacy identity. */
export function adoptedLegacySessionsElsewhere(
  db: Pick<ReturnType<typeof getDb>, 'select'>,
  sourceFile: string,
  detected: DetectedSession[]
) {
  if (!detected.length) return []
  return db
    .select({ row: sessions, legacy: sessionLegacyRecords.session })
    .from(sessionLegacyRecords)
    .innerJoin(sessions, eq(sessions.id, sessionLegacyRecords.sessionId))
    .where(and(ne(sessions.sourceFile, ''), ne(sessions.sourceFile, sourceFile)))
    .all()
    .filter(
      ({ legacy }) =>
        legacy.source === 'auto' &&
        !legacy.sourceFile &&
        legacy.claudeSessionId?.trim() &&
        detected.some(
          (interval) =>
            interval.tool === legacy.tool && interval.claudeSessionId === legacy.claudeSessionId
        )
    )
    .map(({ row }) => row)
}

/** A known conversation suggests adoption, but never authorizes it automatically. */
export function sourceLessLegacySessions(
  db: Pick<ReturnType<typeof getDb>, 'select'>,
  detected: DetectedSession[]
) {
  if (!detected.length) return []
  return db
    .select()
    .from(sessions)
    .where(
      and(
        eq(sessions.source, 'auto'),
        or(isNull(sessions.sourceFile), eq(sessions.sourceFile, '')),
        activeSessionCondition,
        sql`NOT EXISTS (SELECT 1 FROM ${sessionDerivations} WHERE ${sessionDerivations.sessionId} = ${sessions.id})`
      )
    )
    .orderBy(sessions.id)
    .all()
    .filter(
      (row) =>
        row.claudeSessionId?.trim() &&
        detected.some(
          (interval) =>
            interval.tool === row.tool && interval.claudeSessionId === row.claudeSessionId
        )
    )
}

/** Conversation identity is only a review candidate, never an inferred deleted range. */
export function sourceLessLegacyDeletions(
  db: Pick<ReturnType<typeof getDb>, 'select'>,
  detected: DetectedSession[]
) {
  if (!detected.length) return []
  return db
    .select()
    .from(sessionDeletions)
    .where(
      and(
        isNotNull(sessionDeletions.legacyRecordId),
        or(isNull(sessionDeletions.sourceFile), eq(sessionDeletions.sourceFile, ''))
      )
    )
    .orderBy(sessionDeletions.sessionId)
    .all()
    .filter(
      (deletion) =>
        deletion.claudeSessionId?.trim() &&
        detected.some(
          (interval) =>
            interval.tool === deletion.tool && interval.claudeSessionId === deletion.claudeSessionId
        )
    )
}

/** Preserve a legacy snapshot atomically with its deletion, split or mapping. */
export function retainLegacySession(
  tx: Pick<ReturnType<typeof getDb>, 'select' | 'insert'>,
  session: Session
): string {
  const existing = tx
    .select()
    .from(sessionLegacyRecords)
    .where(eq(sessionLegacyRecords.sessionId, session.id))
    .get()
  if (existing) return existing.id
  const modelUsage = tx
    .select({
      model: sessionModelUsage.model,
      inputTokens: sessionModelUsage.inputTokens,
      outputTokens: sessionModelUsage.outputTokens,
      cacheCreationInputTokens: sessionModelUsage.cacheCreationInputTokens,
      cacheReadInputTokens: sessionModelUsage.cacheReadInputTokens
    })
    .from(sessionModelUsage)
    .where(eq(sessionModelUsage.sessionId, session.id))
    .orderBy(sessionModelUsage.model)
    .all()
  const id = randomUUID()
  tx.insert(sessionLegacyRecords)
    .values({
      id,
      sessionId: session.id,
      version: 1,
      session,
      modelUsage,
      createdAt: new Date().toISOString()
    })
    .run()
  return id
}
