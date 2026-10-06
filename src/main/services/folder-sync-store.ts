import { randomUUID } from 'node:crypto'
import { finishSyncSteps } from './folder-sync-steps'
import { and, eq, inArray, isNull, isNotNull, notExists, sql } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import type { getDb } from '../db'
import {
  syncBatchChanges,
  syncBatches,
  syncChanges,
  syncOutbox,
  syncReceipts,
  syncWriterState
} from '../db/schema/folder-sync'
import { AppError } from '../../shared/types/ipc'
import {
  canonicalJson,
  encodeSyncBatch,
  parseSyncBatch,
  parseChange,
  isSyncUuid,
  SyncError,
  type SyncBatch,
  type SyncChange
} from './folder-sync-protocol'

type Transaction = Pick<ReturnType<typeof getDb>, 'select' | 'insert' | 'update' | 'delete'>

/** Only local database projections belong here. Import adapters never invoke providers. */
export interface SyncDomainAdapter {
  validate(change: SyncChange): void
  apply(tx: Transaction, workspaceId: string, change: SyncChange): void
  /** Optional transaction-local accumulator for an incoming batch. */
  forBatch?(): SyncDomainAdapter
  /** Must finish derived state before the batch receipt commits. */
  flush?(tx: Transaction, workspaceId: string): void
}

function conflict(message: string): never {
  throw new AppError('SYNC_ID_CONFLICT', message)
}

function knownChanges(
  tx: Pick<Transaction, 'select'>,
  workspaceId: string,
  required: string[]
): Set<string> {
  const ids = [...new Set(required)]
  const known = new Set<string>()
  for (let offset = 0; offset < ids.length; offset += 500) {
    const rows = tx
      .select({ id: syncChanges.id, workspaceId: syncChanges.workspaceId })
      .from(syncChanges)
      // IDs are globally unique. Query that index first; combining a large IN list
      // with workspace_id makes SQLite scan the whole workspace on each page.
      .where(inArray(syncChanges.id, ids.slice(offset, offset + 500)))
      .all()
    for (const row of rows) if (row.workspaceId === workspaceId) known.add(row.id)
  }
  return known
}

/** Dependencies within an operation are ordered explicitly, never by file or clock order. */
function orderedChanges(changes: SyncChange[]): SyncChange[] {
  const pending = new Map(changes.map((change) => [change.id, change]))
  if (pending.size !== changes.length) conflict('A batch repeats a change ID')
  const result: SyncChange[] = []
  while (pending.size) {
    const ready = [...pending.values()]
      .filter((change) => change.dependencies.every((dependency) => !pending.has(dependency)))
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    if (!ready.length)
      throw new AppError('SYNC_DEPENDENCY_CYCLE', 'Changes contain a dependency cycle')
    for (const change of ready) {
      result.push(change)
      pending.delete(change.id)
    }
  }
  return result
}

function externalDependencies(batch: Pick<SyncBatch, 'dependencies' | 'changes'>): string[] {
  const included = new Set(batch.changes.map((change) => change.id))
  return [
    ...new Set([...batch.dependencies, ...batch.changes.flatMap((change) => change.dependencies)])
  ]
    .filter((id) => !included.has(id))
    .sort()
}

function existingChange(
  tx: Pick<Transaction, 'select'>,
  workspaceId: string,
  change: SyncChange
): boolean {
  const existing = tx.select().from(syncChanges).where(eq(syncChanges.id, change.id)).get()
  if (!existing) return false
  if (existing.workspaceId !== workspaceId || existing.changeJson !== canonicalJson(change))
    conflict('A change ID has different contents or belongs to another workspace')
  return true
}

function insertChange(
  tx: Transaction,
  workspaceId: string,
  change: SyncChange,
  origin: 'local' | 'imported'
): boolean {
  if (existingChange(tx, workspaceId, change)) return false
  tx.insert(syncChanges)
    .values({
      id: change.id,
      workspaceId,
      kind: change.kind,
      entityType: change.entityType,
      entityId: change.entityId,
      changeJson: canonicalJson(change),
      origin,
      recordedAt: new Date().toISOString()
    })
    .run()
  return true
}

/** Call inside the business operation's transaction, including while its folder is offline. */
export function recordLocalSyncChanges<TSchema extends Record<string, unknown>>(
  db: BetterSQLite3Database<TSchema>,
  workspaceId: string,
  values: unknown[],
  adapter: SyncDomainAdapter
): string[] {
  if (!isSyncUuid(workspaceId))
    throw new AppError('INVALID_SYNC_WORKSPACE', 'A workspace UUID is required')
  const changes = orderedChanges(values.map((value) => parseChange(value)))
  changes.forEach((change) => adapter.validate(change))
  return db.transaction((tx) => {
    const known = knownChanges(
      tx,
      workspaceId,
      changes.flatMap((change) => change.dependencies)
    )
    for (const change of changes) {
      if (change.dependencies.some((id) => !known.has(id)))
        throw new AppError(
          'SYNC_MISSING_DEPENDENCY',
          'A local edit is missing its observed history'
        )
      if (insertChange(tx, workspaceId, change, 'local')) adapter.apply(tx, workspaceId, change)
      known.add(change.id)
    }
    return changes.map((change) => change.id)
  })
}

function persistBatch(
  tx: Transaction,
  batch: SyncBatch,
  direction: 'incoming' | 'outgoing'
): boolean {
  const json = canonicalJson(batch)
  const existing = tx.select().from(syncBatches).where(eq(syncBatches.id, batch.batchId)).get()
  if (existing) {
    if (existing.envelopeJson !== json) conflict('A batch ID has different contents')
    return false
  }
  const sequence = tx
    .select()
    .from(syncBatches)
    .where(
      and(
        eq(syncBatches.workspaceId, batch.workspaceId),
        eq(syncBatches.writerEpochId, batch.writerEpochId),
        eq(syncBatches.sequence, batch.sequence)
      )
    )
    .get()
  if (sequence) conflict('Two batches claim the same writer sequence')
  tx.insert(syncBatches)
    .values({
      id: batch.batchId,
      workspaceId: batch.workspaceId,
      writerEpochId: batch.writerEpochId,
      sequence: batch.sequence,
      deviceId: batch.deviceId,
      checksum: batch.checksum,
      envelopeJson: json,
      direction,
      recordedAt: new Date().toISOString()
    })
    .run()
  return true
}

/** Assembling an envelope commits its sequence, membership and retained copy together. */
export function assembleOutgoingBatch<TSchema extends Record<string, unknown>>(
  db: BetterSQLite3Database<TSchema>,
  workspaceId: string,
  writer: { writerEpochId: string; deviceId: string },
  maximumChanges = 500,
  cursor?: { rowid: number },
  scanThrough = Number.MAX_SAFE_INTEGER
): SyncBatch | null {
  if (!Number.isSafeInteger(maximumChanges) || maximumChanges < 1 || maximumChanges > 5000)
    throw new AppError('INVALID_SYNC_BATCH_SIZE', 'Choose between 1 and 5000 changes per batch')
  return db.transaction(
    (tx) => {
      const after = cursor?.rowid ?? 0
      // Force the rowid range: a workspace index otherwise scans and sorts the entire
      // ledger for every page. Commit order improves delivery, never causal meaning.
      let changes = tx
        .all<{ changeJson: string }>(
          sql`
        SELECT c.change_json AS changeJson FROM sync_changes c NOT INDEXED
        WHERE c.rowid > ${after} AND c.rowid <= ${scanThrough}
          AND c.workspace_id = ${workspaceId} AND c.origin = 'local'
          AND NOT EXISTS (SELECT 1 FROM sync_batch_changes m
            JOIN sync_outbox o ON o.batch_id = m.batch_id WHERE m.change_id = c.id)
        ORDER BY c.rowid LIMIT ${maximumChanges}
      `
        )
        .map((row) => parseChange(JSON.parse(row.changeJson)))
      if (!changes.length) return null
      const state = tx
        .select()
        .from(syncWriterState)
        .where(eq(syncWriterState.writerEpochId, writer.writerEpochId))
        .get()
      if (state && state.workspaceId !== workspaceId)
        conflict('A writer epoch belongs to another workspace')
      const sequence = state?.nextSequence ?? 1
      if (!Number.isSafeInteger(sequence + 1))
        throw new AppError('SYNC_SEQUENCE_EXHAUSTED', 'Restart to obtain a new writer epoch')
      let batch: SyncBatch
      while (true) {
        try {
          batch = encodeSyncBatch({
            workspaceId,
            batchId: randomUUID(),
            ...writer,
            sequence,
            changes,
            dependencies: externalDependencies({ changes, dependencies: [] })
          }).batch
          break
        } catch (error) {
          if (
            !(error instanceof SyncError) ||
            error.code !== 'SYNC_TOO_LARGE' ||
            changes.length === 1
          )
            throw error
          changes = changes.slice(0, Math.ceil(changes.length / 2))
        }
      }
      persistBatch(tx, batch, 'outgoing')
      tx.insert(syncOutbox).values({ batchId: batch.batchId }).run()
      for (const change of changes)
        tx.insert(syncBatchChanges).values({ batchId: batch.batchId, changeId: change.id }).run()
      tx.insert(syncWriterState)
        .values({ writerEpochId: writer.writerEpochId, workspaceId, nextSequence: sequence + 1 })
        .onConflictDoUpdate({
          target: syncWriterState.writerEpochId,
          set: { nextSequence: sequence + 1 }
        })
        .run()
      if (cursor) {
        // Advance only over the prefix actually committed (oversized batches may be split).
        cursor.rowid = tx.get<{ rowid: number }>(sql`
          select rowid from sync_changes where id = ${changes[changes.length - 1].id}
        `)!.rowid
      }
      return batch
    },
    { behavior: 'immediate' }
  )
}

/** A received complete envelope is durable even while its actual dependencies are missing. */
export function retainIncomingBatch<TSchema extends Record<string, unknown>>(
  db: BetterSQLite3Database<TSchema>,
  workspaceId: string,
  value: unknown,
  adapter: SyncDomainAdapter
): boolean {
  const batch = parseSyncBatch(value, { workspaceId })
  orderedChanges(batch.changes)
  batch.changes.forEach((change) => adapter.validate(change))
  return db.transaction((tx) => persistBatch(tx, batch, 'incoming'), { behavior: 'immediate' })
}

/** Each complete operation and its receipt commit atomically. Unrelated writers keep moving. */
export function applyReadySyncBatches<TSchema extends Record<string, unknown>>(
  db: BetterSQLite3Database<TSchema>,
  workspaceId: string,
  adapter: SyncDomainAdapter,
  heldBatchIds: ReadonlySet<string> = new Set()
) {
  return finishSyncSteps(applyReadySyncBatchSteps(db, workspaceId, adapter, heldBatchIds))
}

export function* applyReadySyncBatchSteps<TSchema extends Record<string, unknown>>(
  db: BetterSQLite3Database<TSchema>,
  workspaceId: string,
  adapter: SyncDomainAdapter,
  heldBatchIds: ReadonlySet<string> = new Set()
): Generator<
  void,
  {
    applied: string[]
    waiting: Array<{ batchId: string; missing: string[] }>
    errors: Array<{ batchId: string; message: string; code?: string }>
  }
> {
  const applied: string[] = []
  const errors = new Map<string, { message: string; code?: string }>()
  let waiting: Array<{ batchId: string; missing: string[] }> = []
  while (true) {
    let progressed = false
    waiting = []
    const pending = db
      .select({ id: syncBatches.id })
      .from(syncBatches)
      .leftJoin(syncReceipts, eq(syncReceipts.batchId, syncBatches.id))
      .where(
        and(
          eq(syncBatches.workspaceId, workspaceId),
          eq(syncBatches.direction, 'incoming'),
          isNull(syncReceipts.batchId)
        )
      )
      .orderBy(syncBatches.writerEpochId, syncBatches.sequence)
      .all()
    for (const row of pending) {
      yield
      if (errors.has(row.id) || heldBatchIds.has(row.id)) continue
      try {
        const result = db.transaction(
          (tx) => {
            const body = tx
              .select({ json: syncBatches.envelopeJson })
              .from(syncBatches)
              .where(eq(syncBatches.id, row.id))
              .get()!
            const batch = parseSyncBatch(JSON.parse(body.json), { workspaceId })
            const dependencies = externalDependencies(batch)
            const known = knownChanges(tx, workspaceId, dependencies)
            const missing = dependencies.filter((id) => !known.has(id))
            if (missing.length) return missing
            const changes = orderedChanges(batch.changes)
            const domain = adapter.forBatch?.() ?? adapter
            changes.forEach((change) => domain.validate(change))
            for (const change of changes) {
              if (insertChange(tx, workspaceId, change, 'imported'))
                domain.apply(tx, workspaceId, change)
              tx.insert(syncBatchChanges)
                .values({ batchId: row.id, changeId: change.id })
                .onConflictDoNothing()
                .run()
            }
            domain.flush?.(tx, workspaceId)
            tx.insert(syncReceipts)
              .values({ batchId: row.id, importedAt: new Date().toISOString() })
              .run()
            return null
          },
          { behavior: 'immediate' }
        )
        if (result) waiting.push({ batchId: row.id, missing: result })
        else {
          applied.push(row.id)
          progressed = true
        }
      } catch (error) {
        errors.set(row.id, {
          message: error instanceof Error ? error.message : 'Unable to apply batch',
          ...(error instanceof AppError ? { code: error.code } : {})
        })
      }
    }
    if (!progressed) break
  }
  return {
    applied,
    waiting,
    errors: [...errors].map(([batchId, error]) => ({ batchId, ...error }))
  }
}

export function unpublishedSyncBatches<TSchema extends Record<string, unknown>>(
  db: BetterSQLite3Database<TSchema>,
  workspaceId: string
): SyncBatch[] {
  return db
    .select({ json: syncBatches.envelopeJson })
    .from(syncOutbox)
    .innerJoin(syncBatches, eq(syncBatches.id, syncOutbox.batchId))
    .where(and(eq(syncBatches.workspaceId, workspaceId), isNull(syncOutbox.publishedAt)))
    .orderBy(syncBatches.writerEpochId, syncBatches.sequence)
    .all()
    .map((row) => parseSyncBatch(JSON.parse(row.json), { workspaceId }))
}

export function markSyncBatchPublished<TSchema extends Record<string, unknown>>(
  db: BetterSQLite3Database<TSchema>,
  batchId: string
): void {
  db.update(syncOutbox)
    .set({ publishedAt: new Date().toISOString() })
    .where(and(eq(syncOutbox.batchId, batchId), isNull(syncOutbox.publishedAt)))
    .run()
}

/** Compact ranges keep maliciously large sequence gaps bounded and visible. */
export function knownSyncGaps<TSchema extends Record<string, unknown>>(
  db: BetterSQLite3Database<TSchema>,
  workspaceId: string
): Array<{ writerEpochId: string; from: number; to: number }> {
  const batches = db
    .select({ writer: syncBatches.writerEpochId, sequence: syncBatches.sequence })
    .from(syncBatches)
    .where(eq(syncBatches.workspaceId, workspaceId))
    .orderBy(syncBatches.writerEpochId, syncBatches.sequence)
    .all()
  const next = new Map<string, number>()
  const gaps: Array<{ writerEpochId: string; from: number; to: number }> = []
  for (const batch of batches) {
    const expected = next.get(batch.writer) ?? 1
    if (batch.sequence > expected)
      gaps.push({ writerEpochId: batch.writer, from: expected, to: batch.sequence - 1 })
    next.set(batch.writer, batch.sequence + 1)
  }
  return gaps
}

/** Local changes lacking even a completed local folder publication, including unbatched work. */
export function pendingSyncChangeCount<TSchema extends Record<string, unknown>>(
  db: BetterSQLite3Database<TSchema>,
  workspaceId: string
): number {
  const published = db
    .select({ id: syncBatchChanges.changeId })
    .from(syncBatchChanges)
    .innerJoin(syncOutbox, eq(syncOutbox.batchId, syncBatchChanges.batchId))
    .where(and(eq(syncBatchChanges.changeId, syncChanges.id), isNotNull(syncOutbox.publishedAt)))
  return db
    .select({ count: sql<number>`count(*)` })
    .from(syncChanges)
    .where(
      and(
        eq(syncChanges.workspaceId, workspaceId),
        eq(syncChanges.origin, 'local'),
        notExists(published)
      )
    )
    .get()!.count
}

/** Count bounded rowid windows, yielding even when every fact is already published. */
export function* pendingSyncChangeCountSteps<TSchema extends Record<string, unknown>>(
  db: BetterSQLite3Database<TSchema>,
  workspaceId: string
): Generator<void, number> {
  let cursor = 0
  let count = 0
  while (true) {
    const rows = db.all<{ rowid: number }>(sql`
      SELECT rowid FROM sync_changes WHERE rowid > ${cursor} ORDER BY rowid LIMIT 1000
    `)
    if (!rows.length) return count
    const end = rows[rows.length - 1].rowid
    count += db.get<{ count: number }>(sql`
      SELECT count(*) AS count FROM sync_changes c NOT INDEXED
      WHERE c.rowid > ${cursor} AND c.rowid <= ${end}
        AND c.workspace_id = ${workspaceId} AND c.origin = 'local'
        AND NOT EXISTS (SELECT 1 FROM sync_batch_changes m
          JOIN sync_outbox o ON o.batch_id = m.batch_id
          WHERE m.change_id = c.id AND o.published_at IS NOT NULL)
    `)!.count
    cursor = end
    yield
  }
}
