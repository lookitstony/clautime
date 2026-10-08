import { sessionLegacyRecords } from '../db/schema/session-legacy'
import { getLegacyEditView } from './folder-sync-legacy-edits'
import { createHash } from 'node:crypto'
import { and, eq } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { AppError } from '../../shared/types/ipc'
import { clients } from '../db/schema/clients'
import { projects } from '../db/schema/projects'
import { sessions } from '../db/schema/sessions'
import { activeSessionCondition } from '../db/schema/session-deletions'
import { manualTimeEntries } from '../db/schema/manual-time-entries'
import { sessionActivityMappings } from '../db/schema/session-activity-mappings'
import { historySyncWorkspace } from './folder-sync-history-records'
import { portableIdOfClientRow, getPortableProjectId } from './folder-sync-builtin-client'
import {
  getDirectoryRecordView,
  portableClientValues,
  portableProjectValues
} from './folder-sync-directory-records'
import { getManualEntryView } from './folder-sync-manual-records'
import { readPortableSessionRecords } from './folder-sync-session-records'
import {
  observedSessionEditHeads,
  type PortableSessionFragment
} from './folder-sync-session-overlay'
import { portableCoverageHash } from './folder-sync-portable-coverage'
import type { RecordView } from './folder-sync-revisions'

/*
 * Optimistic freshness for ordinary edits while folder sync is connected.
 *
 * Causal journaling supersedes the heads current at save time, so an editor opened before an
 * incoming change would silently overwrite it. Editors therefore capture the syncVersion shown
 * when they open and send it back as expectedSyncVersion; the save is refused with
 * SYNC_STALE_EDIT unless the record still has exactly that version.
 *
 * A version hashes the workspace, the record's causal heads/lifecycle/conflicts and its local
 * row snapshot (plus, for adopted activity, its mapping proof). Any change refuses the edit, even
 * to a field the editor did not touch: stale edits are conservative. A retained workspace counts
 * whether or not transfer is enabled, because offline edits are still shared later. Without a
 * workspace there is no version and edits behave as before. Reading a version only selects: it
 * never bootstraps, journals or initializes policy.
 */

type Db<S extends Record<string, unknown>> = BetterSQLite3Database<S>

export const SYNC_STALE_EDIT = 'SYNC_STALE_EDIT'

export type SyncEditTarget =
  | { kind: 'client'; id: number }
  | { kind: 'project'; id: number }
  | { kind: 'session'; id: number }

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const object = value as Record<string, unknown>
    return `{${Object.keys(object)
      .sort()
      .filter((key) => object[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${canonical(object[key])}`)
      .join(',')}}`
  }
  return JSON.stringify(value ?? null)
}

function causal(view: RecordView): unknown {
  return { lifecycle: view.lifecycle, heads: view.heads, conflicts: [...view.conflicts].sort() }
}

function sessionSnapshot<S extends Record<string, unknown>>(
  db: Db<S>,
  workspaceId: string,
  id: number
): unknown {
  const row = db
    .select()
    .from(sessions)
    .where(and(eq(sessions.id, id), activeSessionCondition))
    .get()
  if (!row) return { missing: true }
  // A growing live session re-measures constantly; its saved times join once it completes.
  const settled = row.status !== 'active'
  const local = {
    source: row.source,
    status: row.status,
    description: row.description,
    billable: !!row.billable,
    projectId: row.projectId,
    clientId: row.clientId,
    ...(settled && {
      startedAt: row.startedAt,
      endedAt: row.endedAt,
      durationMinutes: row.durationMinutes
    })
  }
  const manual = db
    .select({ id: manualTimeEntries.id })
    .from(manualTimeEntries)
    .where(eq(manualTimeEntries.sessionId, id))
    .get()
  if (manual)
    return {
      local,
      manual: manual.id,
      view: causal(getManualEntryView(db, workspaceId, manual.id))
    }
  const mapping = db
    .select()
    .from(sessionActivityMappings)
    .where(eq(sessionActivityMappings.sessionId, id))
    .get()
  if (!mapping) {
    const legacy = db
      .select()
      .from(sessionLegacyRecords)
      .where(eq(sessionLegacyRecords.sessionId, id))
      .get()
    return {
      local,
      ...(legacy
        ? { legacy: legacy.id, view: causal(getLegacyEditView(db, workspaceId, legacy.id)) }
        : {})
    }
  }
  const target = { provider: mapping.provider, conversationId: mapping.conversationId }
  const fragment = JSON.parse(mapping.intervalJson) as PortableSessionFragment
  const records = readPortableSessionRecords(db, workspaceId, target)
  return {
    local,
    mapping: {
      ...target,
      startedAt: fragment.startedAt,
      ...(settled && {
        coverage: portableCoverageHash(target.provider, target.conversationId, fragment.coverage)
      }),
      proof: records.mapping ? causal(records.mapping.view) : null,
      edits: observedSessionEditHeads(fragment, records.edits)
    }
  }
}

function snapshot<S extends Record<string, unknown>>(
  db: Db<S>,
  workspaceId: string,
  target: SyncEditTarget
): unknown {
  if (target.kind === 'session') return sessionSnapshot(db, workspaceId, target.id)
  if (target.kind === 'client') {
    const row = db.select().from(clients).where(eq(clients.id, target.id)).get()
    if (!row) return { missing: true }
    const entityId = portableIdOfClientRow(db, row)
    return {
      entityId,
      local: portableClientValues(row),
      view: causal(getDirectoryRecordView(db, workspaceId, 'client', entityId))
    }
  }
  const row = db.select().from(projects).where(eq(projects.id, target.id)).get()
  if (!row) return { missing: true }
  let local: unknown
  try {
    local = portableProjectValues(db, row)
  } catch (error) {
    // A read must never fail; a dangling client still versions by its local ID.
    if (!(error instanceof AppError)) throw error
    local = { ...row, directoryPath: undefined }
  }
  return {
    entityId: getPortableProjectId(db, row.id),
    local,
    view: causal(
      getDirectoryRecordView(db, workspaceId, 'project', getPortableProjectId(db, row.id)!)
    )
  }
}

/** The record's current edit version, or undefined when no sync workspace is retained. */
export function readSyncEditVersion<S extends Record<string, unknown>>(
  db: Db<S>,
  target: SyncEditTarget
): string | undefined {
  const workspaceId = historySyncWorkspace(db)
  if (!workspaceId) return undefined
  const body = {
    purpose: 'clautime-sync-edit-version-1',
    workspaceId,
    target,
    state: snapshot(db, workspaceId, target)
  }
  return createHash('sha256').update(canonical(body)).digest('hex')
}

/**
 * Call at the entry of a user edit, before mutating anything and without awaiting in between.
 * `required` rejects editors that captured no version while a workspace is retained (opened
 * before connecting, or an outdated caller); internal automatic writes pass neither.
 */
export function assertFreshSyncEdit<S extends Record<string, unknown>>(
  db: Db<S>,
  target: SyncEditTarget,
  expectedSyncVersion: string | undefined,
  required = false
): void {
  if (expectedSyncVersion === undefined && !required) return
  const current = readSyncEditVersion(db, target)
  if (current === undefined || current === expectedSyncVersion) return
  throw new AppError(
    SYNC_STALE_EDIT,
    `${SYNC_STALE_EDIT}: This ${target.kind} changed since you opened it. Reload to see the latest values; your unsaved changes were not applied.`
  )
}
