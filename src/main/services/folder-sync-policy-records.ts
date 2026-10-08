import { randomUUID } from 'node:crypto'
import { and, eq } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { folderSyncSettings, syncChanges, syncRecordStates } from '../db/schema/folder-sync'
import { workspacePolicy } from '../db/schema/workspace-policy'
import { AppError } from '../../shared/types/ipc'
import { readTrackingPolicy } from '../../shared/tracking-policy'
import { canonicalJson, isSyncUuid, parseChange, SyncError } from './folder-sync-protocol'
import { syncFactChangeId } from './folder-sync-activity-records'
import {
  checkRevision,
  materializeRecord,
  planRevision,
  readRevisionChange,
  type RecordSchema,
  type RevisionAction,
  type RevisionChange
} from './folder-sync-revisions'
import { recordLocalSyncChanges, type SyncDomainAdapter } from './folder-sync-store'

type Reader = Pick<Parameters<SyncDomainAdapter['apply']>[0], 'select'>

function policy(value: unknown) {
  try {
    return readTrackingPolicy(value)
  } catch (error) {
    if (error instanceof AppError && error.code === 'UNSUPPORTED_TRACKING_POLICY')
      throw new SyncError(
        'SYNC_UPDATE_REQUIRED',
        'Update ClauTime to use this shared tracking policy.'
      )
    throw new SyncError('SYNC_MALFORMED', 'The shared tracking policy is invalid.')
  }
}

/** One atomic policy field prevents combining timeout/timezone/version from different edits. */
export const WORKSPACE_POLICY_SYNC_SCHEMA: RecordSchema = {
  entityType: 'workspace-policy',
  fields: ['policy'],
  validate: (field, value) => field === 'policy' && !!policy(value)
}

function history(db: Reader, workspaceId: string): RevisionChange[] {
  return db
    .select({ json: syncChanges.changeJson })
    .from(syncChanges)
    .where(
      and(
        eq(syncChanges.workspaceId, workspaceId),
        eq(syncChanges.entityType, 'workspace-policy'),
        eq(syncChanges.entityId, workspaceId)
      )
    )
    .all()
    .map((row) => JSON.parse(row.json) as RevisionChange)
}

export function sharedWorkspacePolicyView(db: Reader, workspaceId: string) {
  return materializeRecord(WORKSPACE_POLICY_SYNC_SCHEMA, workspaceId, history(db, workspaceId))
}

export function validateWorkspacePolicyChange(value: unknown): void {
  const change = parseChange(value)
  if (
    change.kind !== 'revision' ||
    change.entityType !== 'workspace-policy' ||
    !isSyncUuid(change.entityId)
  )
    throw new SyncError('SYNC_MALFORMED', 'Expected a shared tracking policy revision.')
  const revision = readRevisionChange(change, WORKSPACE_POLICY_SYNC_SCHEMA)
  if (revision.fields.get('$present')?.value !== true || !revision.fields.has('policy'))
    throw new SyncError('SYNC_MALFORMED', 'A shared tracking policy cannot be removed.')
}

/** Logical import only; the mapping application separately checks any recalculation. */
export const workspacePolicySyncAdapter: SyncDomainAdapter = {
  validate: validateWorkspacePolicyChange,
  apply(tx, workspaceId, change) {
    validateWorkspacePolicyChange(change)
    if (change.entityId !== workspaceId)
      throw new SyncError(
        'SYNC_WRONG_WORKSPACE',
        'Tracking policy belongs to another shared history.'
      )
    const revisions = history(tx, workspaceId)
    const byId = new Map(revisions.map((row) => [row.id, row]))
    const checked = checkRevision(change, WORKSPACE_POLICY_SYNC_SCHEMA, (id) => byId.get(id))
    if (checked.length)
      throw new AppError(
        'SYNC_MISSING_DEPENDENCY',
        'The tracking policy is missing earlier revisions.'
      )
    const view = materializeRecord(WORKSPACE_POLICY_SYNC_SCHEMA, workspaceId, revisions)
    tx.insert(syncRecordStates)
      .values({
        workspaceId,
        entityType: 'workspace-policy',
        entityId: workspaceId,
        stateJson: canonicalJson(view)
      })
      .onConflictDoUpdate({
        target: [
          syncRecordStates.workspaceId,
          syncRecordStates.entityType,
          syncRecordStates.entityId
        ],
        set: { stateJson: canonicalJson(view) }
      })
      .run()
  }
}

export function planWorkspacePolicyRevision(
  db: Reader,
  workspaceId: string,
  id: string,
  action: RevisionAction
): RevisionChange & { entityType: 'workspace-policy' } {
  const change = {
    ...planRevision({
      id,
      schema: WORKSPACE_POLICY_SYNC_SCHEMA,
      entityId: workspaceId,
      history: history(db, workspaceId),
      action
    }),
    entityType: 'workspace-policy' as const
  }
  validateWorkspacePolicyChange(change)
  return change
}

/** Creator only. Joining uses the chosen history's policy, never a second default root. */
export function initialWorkspacePolicyChange(
  db: Reader,
  workspaceId: string
): (RevisionChange & { entityType: 'workspace-policy' }) | null {
  if (history(db, workspaceId).length) return null
  const local = db.select().from(workspacePolicy).where(eq(workspacePolicy.slot, 1)).get()
  if (!local)
    throw new AppError(
      'WORKSPACE_POLICY_REQUIRED',
      'Choose a tracking policy before creating shared history.'
    )
  const value = policy(JSON.parse(local.policyJson))
  return planWorkspacePolicyRevision(
    db,
    workspaceId,
    syncFactChangeId(workspaceId, 'workspace-policy', canonicalJson(value)),
    { type: 'create', values: { policy: { ...value } } }
  )
}

/** Same transaction as the reviewed local policy change; disabled transfer still journals. */
export function journalWorkspacePolicyChange<S extends Record<string, unknown>>(
  db: BetterSQLite3Database<S>,
  candidate: unknown
): void {
  const connection = db
    .select()
    .from(folderSyncSettings)
    .where(eq(folderSyncSettings.slot, 1))
    .get()
  if (!connection) return
  const local = db.select().from(workspacePolicy).where(eq(workspacePolicy.slot, 1)).get()
  if (!local || connection.policyWorkspaceId !== local.workspaceId)
    throw new AppError(
      'SYNC_POLICY_BINDING_REQUIRED',
      'Complete shared-history setup before changing its tracking policy.'
    )
  const view = sharedWorkspacePolicyView(db, connection.workspaceId)
  if (view.lifecycle !== 'present' || view.conflicts.length || view.deferred.length)
    throw new AppError(
      'SYNC_POLICY_CONFLICT',
      'Resolve the shared tracking policy before changing it.'
    )
  const value = policy(candidate)
  if (canonicalJson(view.fields.policy.value) === canonicalJson(value)) return
  const change = planWorkspacePolicyRevision(db, connection.workspaceId, randomUUID(), {
    type: 'edit',
    observedHeads: view.heads,
    values: { policy: { ...value } }
  })
  recordLocalSyncChanges(db, connection.workspaceId, [change], workspacePolicySyncAdapter)
}
