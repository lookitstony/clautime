import { eq } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { syncRecordStates } from '../db/schema/folder-sync'
import type { FolderSyncIssue } from '../../shared/types/folder-sync'
import type { RecordView } from './folder-sync-revisions'
import { readLegacyQueue } from './folder-sync-legacy-records'

/** Reports retained domain conflicts even when every transport file has arrived. */
export function sharedRecordIssues<S extends Record<string, unknown>>(
  db: BetterSQLite3Database<S>,
  workspaceId: string
): FolderSyncIssue[] {
  const issues: FolderSyncIssue[] = []
  for (const row of db
    .select()
    .from(syncRecordStates)
    .where(eq(syncRecordStates.workspaceId, workspaceId))
    .all()) {
    const state = JSON.parse(row.stateJson) as {
      view?: RecordView
      blockers?: string[]
      projectionIssue?: { code: string }
      issue?: string | null
      conflicts?: string[]
      observation?: { terminalConflict?: boolean }
    }
    const view = state.view
    if (
      view?.conflicts.length ||
      view?.lifecycle === 'conflict' ||
      state.blockers?.length ||
      state.projectionIssue ||
      state.issue ||
      state.conflicts?.length ||
      state.observation?.terminalConflict
    )
      issues.push({
        source: `${row.entityType}:${row.entityId}`,
        code: 'SYNC_RECORD_REVIEW_REQUIRED',
        message: `Shared ${row.entityType.replaceAll('-', ' ')} needs review${view?.conflicts.length ? ` (${view.conflicts.filter((field) => field !== '$present').join(', ') || 'deleted and edited elsewhere'})` : ''}.`
      })
  }
  for (const row of readLegacyQueue(db, workspaceId))
    if (row.status !== 'duplicate')
      issues.push({
        source: `legacy:${row.legacyId}`,
        code: 'SYNC_LEGACY_REVIEW_REQUIRED',
        message: row.counting
          ? 'Saved history needs review; its last agreed value still counts.'
          : 'Possibly duplicated saved history is waiting for review outside active totals.'
      })
  return issues
}
