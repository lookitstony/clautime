import { requireNoInvoiceBillingBlockers } from './folder-sync-invoice-records'
import { and, eq, isNull } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { AppError } from '../../shared/types/ipc'
import {
  folderSyncSettings,
  syncBatches,
  syncReceipts,
  syncRecordStates
} from '../db/schema/folder-sync'
import { sessions, type Session } from '../db/schema/sessions'
import { projects } from '../db/schema/projects'
import { manualTimeEntries } from '../db/schema/manual-time-entries'
import { sessionLegacyRecords } from '../db/schema/session-legacy'
import { projectSharedSessions } from './folder-sync-session-projection'
import { getPortableClientId, getPortableProjectId } from './folder-sync-builtin-client'
import { getDirectoryRecordView } from './folder-sync-directory-records'
import { sharedWorkspacePolicyView } from './folder-sync-policy-records'
import { knownSyncGaps } from './folder-sync-store'
import { getWorkspacePolicy } from './workspace-policy'
import { canonicalJson } from './folder-sync-protocol'
import { currentReportingDateKey } from './reporting-calendar'
import type { RecordView } from './folder-sync-revisions'
import { readLegacyQueue } from './folder-sync-legacy-records'

export interface SharedBillingScope {
  clientId: number
  projectId?: number
  startDate?: string
  endDate?: string
}
/** Inspect known gaps and affected conflicts before generating billable descriptions or writes. */
export function assertSharedBillingReady<S extends Record<string, unknown>>(
  db: BetterSQLite3Database<S>,
  scope: SharedBillingScope
): void {
  const connection = db
    .select()
    .from(folderSyncSettings)
    .where(eq(folderSyncSettings.slot, 1))
    .get()
  if (!connection) return
  const pending = db
    .select({ id: syncBatches.id })
    .from(syncBatches)
    .leftJoin(syncReceipts, eq(syncReceipts.batchId, syncBatches.id))
    .where(
      and(
        eq(syncBatches.workspaceId, connection.workspaceId),
        eq(syncBatches.direction, 'incoming'),
        isNull(syncReceipts.batchId)
      )
    )
    .limit(1)
    .get()
  if (pending || knownSyncGaps(db, connection.workspaceId).length)
    throw new AppError(
      'SYNC_BILLING_INCOMPLETE',
      'Shared history has missing changes. Finish syncing before invoicing.'
    )
  const policy = sharedWorkspacePolicyView(db, connection.workspaceId)
  if (
    policy.lifecycle !== 'present' ||
    policy.conflicts.length ||
    policy.deferred.length ||
    canonicalJson(policy.fields.policy?.value ?? null) !==
      canonicalJson(getWorkspacePolicy(db)?.policy ?? null)
  )
    throw new AppError(
      'SYNC_BILLING_CONFLICT',
      'Resolve the shared tracking policy before invoicing.'
    )
  const clientSyncId = getPortableClientId(db, scope.clientId)
  if (!clientSyncId) throw new AppError('CLIENT_NOT_FOUND', 'Client not found.')
  requireNoInvoiceBillingBlockers(db, clientSyncId)
  const client = getDirectoryRecordView(db, connection.workspaceId, 'client', clientSyncId)
  if (client.lifecycle !== 'present' || client.conflicts.length)
    throw new AppError(
      'SYNC_BILLING_CONFLICT',
      'Resolve this client shared changes before invoicing.'
    )
  const inPeriod = (row: Pick<Session, 'startedAt' | 'endedAt'>) =>
    (!scope.startDate || currentReportingDateKey(row.endedAt) >= scope.startDate) &&
    (!scope.endDate || currentReportingDateKey(row.startedAt) <= scope.endDate)
  const rows = db.select().from(sessions).all()
  const affected = (row: Session) =>
    row.clientId === scope.clientId &&
    (scope.projectId === undefined || row.projectId === scope.projectId) &&
    inPeriod(row)
  const selected = new Set(rows.filter(affected).map((row) => row.id))
  const selectedProjects = new Set(
    rows.filter(affected).flatMap((row) => (row.projectId === null ? [] : [row.projectId]))
  )
  if (scope.projectId !== undefined) selectedProjects.add(scope.projectId)
  for (const projectId of selectedProjects) {
    const project = db.select().from(projects).where(eq(projects.id, projectId)).get()
    if (!project) continue
    const view = getDirectoryRecordView(
      db,
      connection.workspaceId,
      'project',
      getPortableProjectId(db, project.id)!
    )
    if (view.lifecycle !== 'present' || view.conflicts.length)
      throw new AppError(
        'SYNC_BILLING_CONFLICT',
        'Resolve the shared project changes for this work before invoicing.'
      )
  }
  const mentionsClient = (view?: RecordView) =>
    !!view &&
    [
      view.fields.clientSyncId?.value,
      ...(view.fields.clientSyncId?.heads.map((head) => head.value) ?? [])
    ].includes(clientSyncId)
  const conflictedConversations = new Set<string>()
  for (const record of db
    .select()
    .from(syncRecordStates)
    .where(eq(syncRecordStates.workspaceId, connection.workspaceId))
    .all()) {
    const state = JSON.parse(record.stateJson) as {
      view?: RecordView
      target?: { provider: string; conversationId: string }
      blockers?: string[]
      projectionIssue?: unknown
    }
    const conflicted =
      !!state.view?.conflicts.length ||
      state.view?.lifecycle === 'conflict' ||
      !!state.blockers?.length ||
      !!state.projectionIssue
    if (state.target && mentionsClient(state.view))
      conflictedConversations.add(
        JSON.stringify([state.target.provider, state.target.conversationId])
      )
    if (!conflicted) continue
    let sessionId: number | undefined
    if (record.entityType === 'manual-entry')
      sessionId = db
        .select()
        .from(manualTimeEntries)
        .where(eq(manualTimeEntries.id, record.entityId))
        .get()?.sessionId
    if (record.entityType === 'legacy-edit')
      sessionId = db
        .select()
        .from(sessionLegacyRecords)
        .where(eq(sessionLegacyRecords.id, record.entityId))
        .get()?.sessionId
    if (
      (sessionId && selected.has(sessionId)) ||
      (mentionsClient(state.view) &&
        (!sessionId || inPeriod(rows.find((row) => row.id === sessionId)!)))
    )
      throw new AppError(
        'SYNC_BILLING_CONFLICT',
        'Resolve shared edits affecting this client work before invoicing.'
      )
  }
  const conversations = new Set([
    ...conflictedConversations,
    ...rows
      .filter((row) => affected(row) && row.source === 'auto' && row.claudeSessionId)
      .map((row) => JSON.stringify([row.tool, row.claudeSessionId]))
  ])
  for (const conversation of conversations) {
    const projection = projectSharedSessions(db, connection.workspaceId, {
      conversationKeys: [conversation]
    })
    for (const issue of projection.issues) {
      const group = rows.filter(
        (row) => JSON.stringify([row.tool, row.claudeSessionId]) === issue.conversation
      )
      if (
        issue.sessionIds.some((id) => selected.has(id)) ||
        group.some(affected) ||
        (conflictedConversations.has(issue.conversation) && (!group.length || group.some(inPeriod)))
      )
        throw new AppError(
          'SYNC_BILLING_CONFLICT',
          'Review shared session history affecting this billing period before invoicing.'
        )
    }
  }
  for (const entry of readLegacyQueue(db, connection.workspaceId)) {
    if (entry.status === 'duplicate') continue
    const local = db
      .select()
      .from(sessionLegacyRecords)
      .where(eq(sessionLegacyRecords.id, entry.legacyId))
      .get()
    if (local && rows.some((row) => row.id === local.sessionId && affected(row)))
      throw new AppError(
        'SYNC_BILLING_CONFLICT',
        'Review possibly duplicated saved history before invoicing this work.'
      )
  }
}
