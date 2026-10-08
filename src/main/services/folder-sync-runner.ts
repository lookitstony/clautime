import { and, eq, isNull, sql } from 'drizzle-orm'
import { finishSyncSteps } from './folder-sync-steps'
import { AppError } from '../../shared/types/ipc'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { syncBatches, syncOutbox } from '../db/schema/folder-sync'
import { encodeSyncBatch, parseSyncBatch, SyncError, type SyncBatch } from './folder-sync-protocol'
import { publishSyncBatch, scanSyncBatches, type SyncWorkspaceLocation } from './folder-sync-files'
import {
  applyReadySyncBatchSteps,
  assembleOutgoingBatch,
  knownSyncGaps,
  markSyncBatchPublished,
  pendingSyncChangeCountSteps,
  retainIncomingBatch,
  type SyncDomainAdapter
} from './folder-sync-store'

export interface FolderSyncRunResult {
  status: 'idle' | 'incomplete' | 'update-required' | 'unavailable'
  /** Successful local publications only; this does not confirm a cloud upload. */
  published: number
  imported: number
  repaired: number
  pending: number
  waiting: Array<{ batchId: string; missing: string[] }>
  gaps: Array<{ writerEpochId: string; from: number; to: number }>
  issues: Array<{ source: string; code: string; message: string }>
}

const bytes = (batch: SyncBatch): Buffer => {
  const { protocol: _protocol, checksum: _checksum, ...input } = batch
  return encodeSyncBatch(input).bytes
}

/** One serialized folder pass; notifications are hints and callers also schedule full passes. */
export function runFolderSync<TSchema extends Record<string, unknown>>(
  db: BetterSQLite3Database<TSchema>,
  location: SyncWorkspaceLocation,
  writer: { deviceId: string; writerEpochId: string },
  adapter: SyncDomainAdapter,
  available?: ReturnType<typeof scanSyncBatches> & { present?: string[] }
): FolderSyncRunResult {
  return finishSyncSteps(runFolderSyncSteps(db, location, writer, adapter, available))
}

export function* runFolderSyncSteps<TSchema extends Record<string, unknown>>(
  db: BetterSQLite3Database<TSchema>,
  location: SyncWorkspaceLocation,
  writer: { deviceId: string; writerEpochId: string },
  adapter: SyncDomainAdapter,
  available?: ReturnType<typeof scanSyncBatches> & { present?: string[] }
): Generator<void, FolderSyncRunResult> {
  const result: FolderSyncRunResult = {
    status: 'idle',
    published: 0,
    imported: 0,
    repaired: 0,
    pending: 0,
    waiting: [],
    gaps: [],
    issues: []
  }
  const issue = (source: string, error: unknown): void => {
    result.issues.push({
      source,
      code: error instanceof AppError ? error.code : 'SYNC_ERROR',
      message: error instanceof Error ? error.message : 'Unable to synchronize history'
    })
  }
  function* pending(): Generator<void> {
    result.pending = yield* pendingSyncChangeCountSteps(db, location.workspaceId)
    result.gaps = knownSyncGaps(db, location.workspaceId)
  }
  let scanned: ReturnType<typeof scanSyncBatches>
  try {
    scanned =
      available ??
      scanSyncBatches(location, { validateChange: (change) => adapter.validate(change) })
  } catch (error) {
    issue(location.folder, error)
    result.status =
      error instanceof SyncError && error.code === 'SYNC_UPDATE_REQUIRED'
        ? 'update-required'
        : 'unavailable'
    yield* pending()
    return result
  }
  for (const entry of scanned.issues) issue(entry.path, entry.error)
  // A newer protocol or normalization must pause the pass, not produce a partial
  // "up to date" view. Ordinary local capture and its SQLite queue remain available.
  if (result.issues.some((entry) => entry.code === 'SYNC_UPDATE_REQUIRED')) {
    result.status = 'update-required'
    yield* pending()
    return result
  }
  const conflicted = new Set(
    scanned.issues.flatMap((entry) => (entry.batchId ? [entry.batchId] : []))
  )
  const present = new Set<string>(available?.present)
  for (const { batch } of scanned.batches) {
    yield
    try {
      retainIncomingBatch(db, location.workspaceId, batch, adapter)
      present.add(batch.batchId)
    } catch (error) {
      conflicted.add(batch.batchId)
      issue(batch.batchId, error)
    }
  }
  const imported = yield* applyReadySyncBatchSteps(db, location.workspaceId, adapter, conflicted)
  result.imported = imported.applied.length
  result.waiting = imported.waiting
  for (const error of imported.errors)
    result.issues.push({
      source: error.batchId,
      code: error.code ?? 'SYNC_ERROR',
      message: error.message
    })
  if (imported.errors.some((error) => error.code === 'SYNC_UPDATE_REQUIRED')) {
    result.status = 'update-required'
    yield* pending()
    return result
  }
  try {
    const cursor = { rowid: 0 }
    while (true) {
      const window = db.all<{ rowid: number }>(sql`
        SELECT rowid FROM sync_changes WHERE rowid > ${cursor.rowid} ORDER BY rowid LIMIT 1000
      `)
      if (!window.length) break
      const end = window[window.length - 1].rowid
      while (assembleOutgoingBatch(db, location.workspaceId, writer, 500, cursor, end)) yield
      cursor.rowid = end
      yield // Even an already-published window gives control back to the application.
    }
  } catch (error) {
    issue('outgoing changes', error)
  }
  // Retained incoming copies can repair a missing original file on a surviving device.
  // This republishes the immutable envelope, never creates another logical change.
  const retained = db
    .select({ id: syncBatches.id })
    .from(syncBatches)
    .where(eq(syncBatches.workspaceId, location.workspaceId))
    .all()
  const unpublished = new Set(
    db
      .select({ id: syncOutbox.batchId })
      .from(syncOutbox)
      .innerJoin(syncBatches, eq(syncBatches.id, syncOutbox.batchId))
      .where(and(eq(syncBatches.workspaceId, location.workspaceId), isNull(syncOutbox.publishedAt)))
      .all()
      .map((row) => row.id)
  )
  for (const row of retained) {
    yield
    if (conflicted.has(row.id)) continue
    if (present.has(row.id)) {
      if (unpublished.has(row.id)) markSyncBatchPublished(db, row.id)
      continue
    }
    try {
      const body = db
        .select({ json: syncBatches.envelopeJson })
        .from(syncBatches)
        .where(eq(syncBatches.id, row.id))
        .get()!
      const batch = parseSyncBatch(JSON.parse(body.json), {
        workspaceId: location.workspaceId,
        validateChange: (change) => adapter.validate(change)
      })
      const encoded = bytes(batch)
      try {
        publishSyncBatch(location, encoded)
      } catch (error) {
        if (!(error instanceof SyncError) || error.code !== 'SYNC_BATCH_CONFLICT') throw error
        issue(row.id, error)
        // Preserve the damaged/partial original; a complete differently named copy
        // remains recognizable by batch ID, and any conflicting valid copy stays visible.
        publishSyncBatch(location, encoded, true)
      }
      if (unpublished.has(row.id)) {
        markSyncBatchPublished(db, row.id)
        result.published++
      } else result.repaired++
    } catch (error) {
      issue(row.id, error)
    }
  }
  yield* pending()
  if (result.waiting.length || result.gaps.length || result.issues.length || result.pending)
    result.status = 'incomplete'
  return result
}
