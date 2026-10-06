import { parentPort, workerData } from 'node:worker_threads'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import {
  listSyncSnapshots,
  readVerifiedSnapshotBatches,
  exportEncodedSyncSnapshot,
  publishEncodedSyncSnapshot
} from '../services/folder-sync-snapshots'
import {
  scanSyncBatchInventory,
  readSyncBatchFile,
  type SyncWorkspaceLocation
} from '../services/folder-sync-files'
import { folderSyncAdapter } from '../services/folder-sync-domains'
import { planDirectoryExport } from '../services/folder-sync-directory-records'
import { sharedRecordIssues } from '../services/folder-sync-status-issues'

export interface SyncReadRequest {
  operation: 'scan' | 'snapshot' | 'publishSnapshot' | 'recordIssues'
  location: SyncWorkspaceLocation
  databasePath?: string
  snapshotId?: string
}

const request = workerData as SyncReadRequest
const validation = { validateChange: folderSyncAdapter.validate }
const errorValue = (error: unknown) => ({
  message: error instanceof Error ? error.message : String(error),
  code: (error as { code?: string })?.code ?? 'SYNC_ERROR'
})
async function sendBatch(batch: unknown): Promise<void> {
  const acknowledged = new Promise<void>((resolve) => parentPort!.once('message', () => resolve()))
  parentPort!.postMessage({ type: 'batch', batch })
  await acknowledged
}
async function run(): Promise<void> {
  if (request.operation === 'scan') {
    const snapshots = listSyncSnapshots(request.location)
    const scan = scanSyncBatchInventory(request.location, validation)
    const known = request.databasePath
      ? new Database(request.databasePath, { readonly: true, fileMustExist: true })
      : undefined
    const present: string[] = []
    try {
      const checksum = known?.prepare(
        'SELECT checksum FROM sync_batches WHERE id = ? AND workspace_id = ?'
      )
      for (const entry of scan.batches) {
        const saved = checksum?.get(entry.batch.batchId, request.location.workspaceId) as
          | { checksum: string }
          | undefined
        if (saved?.checksum === entry.batch.checksum) {
          present.push(entry.batch.batchId)
          continue
        }
        try {
          const batch = readSyncBatchFile(request.location, entry.paths[0], validation)
          if (batch.checksum !== entry.batch.checksum)
            throw Object.assign(new Error('Shared batch changed during reading.'), {
              code: 'SYNC_BATCH_CONFLICT'
            })
          await sendBatch({ batch, paths: entry.paths })
        } catch (error) {
          scan.issues.push({
            path: entry.paths[0],
            batchId: entry.batch.batchId,
            error: error as (typeof scan.issues)[number]['error']
          })
        }
      }
    } finally {
      known?.close()
    }
    parentPort!.postMessage({
      type: 'done',
      value: {
        present,
        snapshots: {
          ...snapshots,
          issues: snapshots.issues.map((row) => ({ ...row, error: errorValue(row.error) }))
        },
        issues: scan.issues.map((row) => ({ ...row, error: errorValue(row.error) }))
      }
    })
  } else if (request.operation === 'snapshot') {
    const known = request.databasePath
      ? new Database(request.databasePath, { readonly: true, fileMustExist: true })
      : undefined
    try {
      const checksum = known?.prepare(
        'SELECT checksum FROM sync_batches WHERE id = ? AND workspace_id = ?'
      )
      for (const batch of readVerifiedSnapshotBatches(
        request.location,
        request.snapshotId!,
        validation
      )) {
        const saved = checksum?.get(batch.batchId, request.location.workspaceId) as
          | { checksum: string }
          | undefined
        if (saved?.checksum !== batch.checksum) await sendBatch(batch)
      }
    } finally {
      known?.close()
    }
    parentPort!.postMessage({ type: 'done', value: null })
  } else {
    // A WAL reader never owns SQLite's write lock. All application writes remain on main.
    const sqlite = new Database(request.databasePath!, { readonly: true, fileMustExist: true })
    try {
      sqlite.pragma('query_only = ON')
      const db = drizzle(sqlite)
      if (request.operation === 'recordIssues') {
        const issues = db.transaction((tx) => sharedRecordIssues(tx, request.location.workspaceId))
        parentPort!.postMessage({ type: 'done', value: issues })
        return
      }
      const plan = db.transaction((tx) => {
        const directory = planDirectoryExport(tx, request.location.workspaceId)
        if (directory.changes.length || directory.invalid.length || directory.blocked.length)
          return null
        return exportEncodedSyncSnapshot(tx, request.location.workspaceId, validation)
      })
      if (plan) publishEncodedSyncSnapshot(request.location, plan)
      parentPort!.postMessage({ type: 'done', value: !!plan })
    } finally {
      sqlite.close()
    }
  }
}
void run().catch((error) => parentPort!.postMessage({ type: 'error', error: errorValue(error) }))
