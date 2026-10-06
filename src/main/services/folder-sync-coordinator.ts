import { eq, sql } from 'drizzle-orm'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { AppError } from '../../shared/types/ipc'
import type {
  ApplyFolderSyncJoinReview,
  ConnectFolderSync,
  FolderSyncJoinReview,
  FolderSyncState,
  FolderSyncIssue
} from '../../shared/types/folder-sync'
import { folderSyncSettings, syncBatches, syncRecordStates } from '../db/schema/folder-sync'
import { sessionLegacyRecords } from '../db/schema/session-legacy'
import { manualTimeEntries } from '../db/schema/manual-time-entries'
import { sessions } from '../db/schema/sessions'
import {
  createSyncWorkspace,
  listSyncWorkspaces,
  openSyncWorkspace,
  scanSyncBatches
} from './folder-sync-files'
import {
  initialWorkspacePolicyChange,
  workspacePolicySyncAdapter
} from './folder-sync-policy-records'
import { getWorkspacePolicy, initializeWorkspacePolicy } from './workspace-policy'
import { projectSharedWorkspacePolicy } from './folder-sync-policy-projection'
import { refreshInvoiceSyncProjections } from './folder-sync-invoice-records'
import { sharedRecordIssues } from './folder-sync-status-issues'
import { bootstrapFolderSyncInSteps } from './folder-sync-bootstrap'
import { exportActivityPage, type ActivityExportPhase } from './folder-sync-activity-export'
import { finishSyncStepsAsync } from './folder-sync-steps'
import { SyncError } from './folder-sync-protocol'
import type { createSyncReadClient } from './folder-sync-read-client'
import { folderSyncAdapter } from './folder-sync-domains'
import {
  pendingSyncChangeCountSteps,
  recordLocalSyncChanges,
  retainIncomingBatch,
  applyReadySyncBatchSteps
} from './folder-sync-store'
import { runFolderSyncSteps } from './folder-sync-runner'
import {
  exportAndPublishSyncSnapshot,
  listSyncSnapshots,
  restoreSyncSnapshot
} from './folder-sync-snapshots'
import {
  collectHistoryObserverChanges,
  journalHistoryObservers
} from './folder-sync-history-observers'
import { resolveLegacyReferences, refreshLegacyState } from './folder-sync-legacy-records'
import { isJoinReviewPending } from './folder-sync-identity-links'
import { applyJoinReview, beginJoinReview, readJoinReview } from './folder-sync-join-review'
import { planDirectoryExport, directoryRecordsAdapter } from './folder-sync-directory-records'

type Db<S extends Record<string, unknown>> = BetterSQLite3Database<S>
interface CoordinatorOptions<S extends Record<string, unknown>> {
  db(): Db<S>
  device(): { deviceId: string; writerEpochId: string }
  localDataDirectory: string
  project(
    db: Db<S>,
    workspaceId: string,
    yieldControl: () => Promise<void>
  ): FolderSyncIssue[] | Promise<FolderSyncIssue[]>
  reads?: ReturnType<typeof createSyncReadClient>
  databasePath?: string
}
const emptyState = (): FolderSyncState => ({
  connected: false,
  enabled: false,
  workspaceId: null,
  name: null,
  folder: null,
  status: 'disabled',
  lastPublishedAt: null,
  lastImportedAt: null,
  pending: 0,
  issues: [],
  joinReviewRequired: false
})
const asIssue = (source: string, error: unknown): FolderSyncIssue => ({
  source,
  code: error instanceof AppError ? error.code : 'SYNC_ERROR',
  message: error instanceof Error ? error.message : String(error)
})

/** One SQLite writer, serialized passes, and cooperative yields between committed operations. */
export function createFolderSyncCoordinator<S extends Record<string, unknown>>(
  options: CoordinatorOptions<S>
) {
  let last = emptyState()
  let transportBlocked = true
  let joinReviewReady = false
  let timer: ReturnType<typeof setInterval> | undefined
  const restoredSnapshots = new Set<string>()
  let checkedVersion: string | undefined
  let bootstrapAt = 0
  let bootstrapIssues: FolderSyncIssue[] = []
  let projectionIssues: FolderSyncIssue[] = []
  let importedLastPass = false
  let queue: Promise<unknown> = Promise.resolve()
  let active = false
  let generation = 0
  let passGeneration = 0
  let dirtyDuringYield = false
  let pendingCount = 0
  const exclusive = <T>(action: () => Promise<T>): Promise<T> => {
    const requestedGeneration = generation
    const result = queue.then(async () => {
      active = true
      passGeneration = requestedGeneration
      try {
        if (passGeneration !== generation) throw new AppError('SYNC_CANCELLED', 'Transfers paused.')
        return await action()
      } finally {
        active = false
        last.progress = undefined
      }
    })
    queue = result.catch(() => {})
    return result
  }
  const waitFor = async <T>(work: Promise<T>): Promise<T> => {
    const before = bootstrapVersion(options.db())
    const result = await work
    if (bootstrapVersion(options.db()) !== before) dirtyDuringYield = true
    if (passGeneration !== generation) throw new AppError('SYNC_CANCELLED', 'Transfers paused.')
    return result
  }
  const yieldControl = async () => {
    await waitFor(new Promise<void>((resolve) => setImmediate(resolve)))
    if (
      last.progress &&
      ['Matching saved history', 'Updating shared history', 'Transferring shared history'].includes(
        last.progress.stage
      )
    )
      last.progress.completed++
  }
  // Immutable sync inputs, not raw-message/heartbeat writes on the shared connection.
  const dataVersion = (db: Db<S>): string =>
    JSON.stringify(
      db.get(sql`SELECT
    (SELECT max(rowid) FROM sync_changes) AS changes,
    (SELECT max(rowid) FROM activity_observations) AS observations,
    (SELECT max(rowid) FROM activity_observers) AS observers,
    (SELECT max(rowid) FROM activity_identities) AS identities,
    (SELECT max(rowid) FROM session_activity_mappings) AS mappings,
    (SELECT max(rowid) FROM session_revisions) AS revisions,
    (SELECT max(rowid) FROM sessions) AS sessions
  `)
    )
  const bootstrapVersion = (db: Db<S>): string =>
    JSON.stringify([
      dataVersion(db),
      db.all(sql`SELECT * FROM clients ORDER BY id`),
      db.all(sql`SELECT * FROM projects ORDER BY id`)
    ])
  const connection = () =>
    options.db().select().from(folderSyncSettings).where(eq(folderSyncSettings.slot, 1)).get()
  function checkedFolder(folder: string): string {
    if (typeof folder !== 'string' || !isAbsolute(folder) || folder.includes('\0'))
      throw new AppError(
        'SYNC_FOLDER_REQUIRED',
        'Choose an absolute local folder already managed by your file-sync provider.'
      )
    const path = resolve(folder)
    const inside = relative(path, resolve(options.localDataDirectory))
    if (!inside || (!inside.startsWith(`..${sep}`) && inside !== '..' && !isAbsolute(inside)))
      throw new AppError(
        'SYNC_LIVE_DATABASE_FOLDER',
        'Choose a separate folder that does not contain ClauTime live database or local credentials.'
      )
    return path
  }
  function status(): FolderSyncState {
    const saved = connection()
    if (!saved) return emptyState()
    return {
      ...last,
      connected: true,
      enabled: !!saved.enabled,
      workspaceId: saved.workspaceId,
      folder: saved.folderPath,
      status: !saved.enabled
        ? 'disabled'
        : last.workspaceId === saved.workspaceId
          ? last.status
          : 'incomplete',
      lastPublishedAt: saved.lastPublishedAt,
      lastImportedAt: saved.lastImportedAt,
      pending: pendingCount,
      issues: last.issues.length
        ? last.issues
        : saved.error
          ? [{ source: 'sync', code: 'SYNC_ERROR', message: saved.error }]
          : [],
      joinReviewRequired: isJoinReviewPending(options.db(), saved.workspaceId),
      joinReviewReady: !!saved.enabled && joinReviewReady
    }
  }
  function discover(folder: string) {
    const found = listSyncWorkspaces(checkedFolder(folder))
    return {
      workspaces: found.workspaces.map((row) => ({
        workspaceId: row.manifest.workspaceId,
        name: row.manifest.name,
        createdAt: row.manifest.createdAt
      })),
      issues: found.issues.map((row) => asIssue(row.path, row.error))
    }
  }
  async function bootstrap(db: Db<S>, workspaceId: string): Promise<FolderSyncIssue[]> {
    const issues: FolderSyncIssue[] = []
    if (!isJoinReviewPending(db, workspaceId)) {
      last.progress = { stage: 'Preparing shared history', completed: 0 }
      for (const phase of ['observations', 'identities', 'machines'] as ActivityExportPhase[]) {
        let cursor = 0
        while (true) {
          await yieldControl()
          const page = exportActivityPage(db, workspaceId, cursor, 100, phase)
          cursor = page.cursor
          last.progress.completed += page.exported
          issues.push(...page.issues)
          if (page.done) break
        }
      }
    }
    last.progress = { stage: 'Matching saved history', completed: 0 }
    issues.push(...(await bootstrapFolderSyncInSteps(db, workspaceId, yieldControl)))
    // A pending join review withholds every local export, provenance included.
    if (isJoinReviewPending(db, workspaceId)) return issues
    const legacyIds = db
      .select({ id: sessionLegacyRecords.id })
      .from(sessionLegacyRecords)
      .all()
      .map((row) => row.id)
    const manualIds = db
      .select({ id: manualTimeEntries.id })
      .from(manualTimeEntries)
      .all()
      .map((row) => row.id)
    for (let offset = 0; offset < Math.max(legacyIds.length, manualIds.length); offset += 100) {
      await yieldControl()
      if (isJoinReviewPending(db, workspaceId)) break
      try {
        db.transaction((tx) => {
          const observers = collectHistoryObserverChanges(
            tx,
            workspaceId,
            options.device().deviceId,
            {
              legacyIds: legacyIds.slice(offset, offset + 100),
              manualIds: manualIds.slice(offset, offset + 100)
            }
          )
          journalHistoryObservers(tx, workspaceId, observers.changes)
        })
      } catch (error) {
        issues.push({ ...asIssue('history observers', error), code: 'SYNC_LOCAL_EXPORT_WITHHELD' })
      }
    }
    return issues
  }
  async function syncNow(completeEmptyReview = true): Promise<FolderSyncState> {
    const saved = connection()
    if (!saved) return status()
    if (!saved.enabled) {
      pendingCount = await finishSyncStepsAsync(
        pendingSyncChangeCountSteps(options.db(), saved.workspaceId),
        yieldControl
      )
      return status()
    }
    transportBlocked = true
    joinReviewReady = false
    const db = options.db()
    const location = { folder: checkedFolder(saved.folderPath), workspaceId: saved.workspaceId }
    const issues: FolderSyncIssue[] = []
    dirtyDuringYield = false
    let restoredCount = 0
    let snapshotFailure = false
    let bootstrapped = false
    try {
      const shared = openSyncWorkspace(location)
      last = { ...status(), name: shared.manifest.name, issues: [] }
      // Local writes invalidate the cached projection. Periodic bootstrap also detects removed logs.
      const changed =
        checkedVersion !== bootstrapVersion(db) ||
        importedLastPass ||
        Date.now() - bootstrapAt >= 5 * 60_000
      if (changed) {
        bootstrapIssues = await bootstrap(db, saved.workspaceId)
        bootstrapAt = Date.now()
        bootstrapped = true
      }
      issues.push(...bootstrapIssues)
      // Inspect every snapshot manifest before applying data, including a protocol upgrade.
      last.progress = { stage: 'Checking shared files', completed: 0 }
      let snapshots: ReturnType<typeof listSyncSnapshots>
      let scan: ReturnType<typeof scanSyncBatches> & { present?: string[] }
      if (options.reads) {
        const present: string[] = []
        const retainedIssues: ReturnType<typeof scanSyncBatches>['issues'] = []
        const result = await waitFor(
          options.reads.run<{
            snapshots: ReturnType<typeof listSyncSnapshots>
            issues: ReturnType<typeof scanSyncBatches>['issues']
            present: string[]
          }>({ operation: 'scan', location, databasePath: options.databasePath }, async (value) => {
            const { batch, paths } = value as ReturnType<typeof scanSyncBatches>['batches'][number]
            try {
              retainIncomingBatch(db, saved.workspaceId, batch, folderSyncAdapter)
              present.push(batch.batchId)
            } catch (error) {
              const issue = asIssue(batch.batchId, error)
              retainedIssues.push({
                path: paths[0],
                batchId: batch.batchId,
                error:
                  error instanceof SyncError
                    ? error
                    : new SyncError('SYNC_MALFORMED', issue.message)
              })
            }
            await yieldControl()
          })
        )
        snapshots = result.snapshots
        scan = {
          batches: [],
          present: [...present, ...result.present],
          issues: [...result.issues, ...retainedIssues]
        }
        for (const issue of [...snapshots.issues, ...scan.issues])
          issue.error = new SyncError(issue.error.code, issue.error.message)
      } else {
        snapshots = listSyncSnapshots(location)
        scan = scanSyncBatches(location, { validateChange: folderSyncAdapter.validate })
      }
      issues.push(...snapshots.issues.map((row) => asIssue(row.path, row.error)))
      issues.push(...scan.issues.map((row) => asIssue(row.path, row.error)))
      if (issues.some((row) => row.code === 'SYNC_UPDATE_REQUIRED')) {
        last = { ...last, status: 'update-required', issues }
      } else {
        const held = new Set(scan.issues.flatMap((row) => (row.batchId ? [row.batchId] : [])))
        // All snapshots retain original envelopes; ordering is an optimization, not authority.
        for (const snapshot of snapshots.snapshots.sort((a, b) => b.batchCount - a.batchCount)) {
          const proof = `${saved.workspaceId}:${snapshot.snapshotId}:${snapshot.checksum}`
          // Recheck delivery before committing identity links, even for a previously read snapshot.
          if (restoredSnapshots.has(proof) && !isJoinReviewPending(db, saved.workspaceId)) continue
          try {
            const restored = options.reads
              ? await (async () => {
                  const snapshotHeld = new Set(held)
                  const errors: Array<{ batchId: string; code?: string; message: string }> = []
                  await waitFor(
                    options.reads!.run(
                      {
                        operation: 'snapshot',
                        location,
                        snapshotId: snapshot.snapshotId,
                        databasePath: options.databasePath
                      },
                      async (value) => {
                        const batch = value as import('./folder-sync-protocol').SyncBatch
                        try {
                          retainIncomingBatch(db, saved.workspaceId, batch, folderSyncAdapter)
                        } catch (error) {
                          snapshotHeld.add(batch.batchId)
                          errors.push({ batchId: batch.batchId, ...asIssue(batch.batchId, error) })
                        }
                        await yieldControl()
                      }
                    )
                  )
                  const applied = await finishSyncStepsAsync(
                    applyReadySyncBatchSteps(
                      db,
                      saved.workspaceId,
                      folderSyncAdapter,
                      snapshotHeld
                    ),
                    yieldControl
                  )
                  return { ...applied, errors: [...errors, ...applied.errors] }
                })()
              : restoreSyncSnapshot(db, location, snapshot.snapshotId, folderSyncAdapter, held)
            restoredCount += restored.applied.length
            if (!restored.errors.length && !restored.waiting.length) restoredSnapshots.add(proof)
            if (restored.errors.length || restored.waiting.length) snapshotFailure = true
            issues.push(
              ...restored.errors.map((row) => ({
                source: row.batchId,
                code: row.code ?? 'SYNC_ERROR',
                message: row.message
              }))
            )
          } catch (error) {
            if (
              error instanceof AppError &&
              ['SYNC_UPDATE_REQUIRED', 'SYNC_CANCELLED'].includes(error.code)
            )
              throw error
            snapshotFailure = true
            issues.push(asIssue(`snapshot:${snapshot.snapshotId}`, error))
          }
        }
        last.progress = { stage: 'Transferring shared history', completed: 0 }
        const run = await finishSyncStepsAsync(
          runFolderSyncSteps(db, location, options.device(), folderSyncAdapter, scan),
          yieldControl
        )
        pendingCount = run.pending
        issues.push(...run.issues)
        const deliveryBlocked =
          snapshotFailure ||
          run.status !== 'idle' ||
          run.waiting.length > 0 ||
          run.gaps.length > 0 ||
          snapshots.issues.length > 0 ||
          scan.issues.length > 0 ||
          issues.some((issue) => issue.source !== 'tracking policy' && issue.code === 'SYNC_ERROR')
        transportBlocked =
          deliveryBlocked ||
          issues.some((issue) =>
            ['SYNC_LOCAL_EXPORT_WITHHELD', 'SYNC_LOCAL_ACTIVITY_WITHHELD'].includes(issue.code)
          )
        const initialHistoryLoaded = snapshots.snapshots.some((snapshot) =>
          restoredSnapshots.has(`${saved.workspaceId}:${snapshot.snapshotId}:${snapshot.checksum}`)
        )
        joinReviewReady = !transportBlocked && initialHistoryLoaded
        if (isJoinReviewPending(db, saved.workspaceId) && !initialHistoryLoaded)
          issues.push({
            source: 'delivery',
            code: 'SYNC_JOIN_HISTORY_INCOMPLETE',
            message:
              'Shared history is still loading. Check sync issues on the original computer, then wait for its files to arrive here.'
          })
        // Unreviewed local clients/projects mean this computer's work is not in the shared scope yet.
        if (isJoinReviewPending(db, saved.workspaceId)) transportBlocked = true
        importedLastPass = run.imported > 0 || restoredCount > 0
        if (run.status !== 'update-required') {
          if (changed || importedLastPass) {
            projectionIssues = []
            const policy = projectSharedWorkspacePolicy(db)
            if (policy.status !== 'ready' && policy.status !== 'applied')
              projectionIssues.push({
                source: 'tracking policy',
                code: 'SYNC_POLICY_REVIEW_REQUIRED',
                message:
                  policy.status === 'review-required'
                    ? policy.reasons.join(', ')
                    : `Shared tracking policy: ${policy.status}`
              })
            else {
              last.progress = { stage: 'Updating shared history', completed: 0 }
              const legacyIds = [
                ...new Set([
                  ...db
                    .select({ id: sessionLegacyRecords.id })
                    .from(sessionLegacyRecords)
                    .all()
                    .map((row) => row.id),
                  ...db
                    .select({ id: syncRecordStates.entityId })
                    .from(syncRecordStates)
                    .where(eq(syncRecordStates.entityType, 'legacy-edit'))
                    .all()
                    .map((row) => row.id)
                ])
              ].sort()
              for (let offset = 0; offset < legacyIds.length; offset += 25) {
                await yieldControl()
                const scope = legacyIds.slice(offset, offset + 25)
                db.transaction((tx) => {
                  resolveLegacyReferences(tx, saved.workspaceId, scope)
                  refreshLegacyState(tx, saved.workspaceId, { legacyIds: scope })
                })
              }
              projectionIssues.push(...(await options.project(db, saved.workspaceId, yieldControl)))
              refreshInvoiceSyncProjections(db)
              projectionIssues.push(
                ...(options.reads && options.databasePath
                  ? await waitFor(
                      options.reads.run<FolderSyncIssue[]>({
                        operation: 'recordIssues',
                        location,
                        databasePath: options.databasePath
                      })
                    )
                  : sharedRecordIssues(db, saved.workspaceId))
              )
            }
          }
          issues.push(...projectionIssues)
          // Doubling retained coverage bounds total snapshot copies as history grows. No pruning.
          const count = db
            .select({ count: sql<number>`count(*)` })
            .from(syncBatches)
            .where(eq(syncBatches.workspaceId, saved.workspaceId))
            .get()!.count
          const previous = Math.max(
            0,
            ...snapshots.snapshots
              .filter((snapshot) =>
                restoredSnapshots.has(
                  `${saved.workspaceId}:${snapshot.snapshotId}:${snapshot.checksum}`
                )
              )
              .map((snapshot) => snapshot.batchCount)
          )
          if (
            !deliveryBlocked &&
            !isJoinReviewPending(db, saved.workspaceId) &&
            run.status === 'idle' &&
            count &&
            (!previous || count >= Math.max(previous + 100, previous * 2))
          ) {
            // A consistent batch snapshot is not enough for joining if directory rows were omitted.
            // Recheck the actual export plan so invalid records, missing parents and a withheld
            // directory transaction all hold the setup snapshot; unrelated activity may still sync.
            const directory = planDirectoryExport(db, saved.workspaceId)
            if (
              !directory.changes.length &&
              !directory.invalid.length &&
              !directory.blocked.length
            ) {
              last.progress = { stage: 'Preparing recovery snapshot', completed: 0 }
              if (options.reads && options.databasePath) {
                await waitFor(
                  options.reads.run({
                    operation: 'publishSnapshot',
                    location,
                    databasePath: options.databasePath
                  })
                )
              } else {
                exportAndPublishSyncSnapshot(db, location, {
                  validateChange: folderSyncAdapter.validate
                })
              }
            }
          }
        }
        const now = new Date().toISOString()
        if (run.published || run.repaired || run.imported || restoredCount)
          db.update(folderSyncSettings)
            .set({
              ...(run.published || run.repaired ? { lastPublishedAt: now } : {}),
              ...(run.imported || restoredCount ? { lastImportedAt: now } : {})
            })
            .where(eq(folderSyncSettings.slot, 1))
            .run()
        last = {
          ...last,
          status: run.status === 'idle' && issues.length ? 'incomplete' : run.status,
          issues
        }
        if (run.waiting.length)
          last.issues.push({
            source: 'delivery',
            code: 'SYNC_DEPENDENCIES_MISSING',
            message: `${run.waiting.length} batch(es) are waiting for missing changes.`
          })
        if (run.gaps.length)
          last.issues.push({
            source: 'delivery',
            code: 'SYNC_BATCH_GAPS',
            message: `${run.gaps.length} writer gap(s) remain visible until their files arrive.`
          })
      }
    } catch (error) {
      if (error instanceof AppError && error.code === 'SYNC_CANCELLED') {
        checkedVersion = undefined
        throw error
      }
      issues.push(asIssue('sync', error))
      last = {
        ...status(),
        status:
          error instanceof AppError && error.code === 'SYNC_UPDATE_REQUIRED'
            ? 'update-required'
            : 'unavailable',
        issues
      }
    }
    last.issues = [...new Map(last.issues.map((issue) => [JSON.stringify(issue), issue])).values()]
    db.update(folderSyncSettings)
      .set({ error: last.issues.map((row) => row.message).join('\n') || null })
      .where(eq(folderSyncSettings.slot, 1))
      .run()
    checkedVersion =
      dirtyDuringYield || last.status === 'unavailable' || last.status === 'update-required'
        ? undefined
        : bootstrapVersion(db)
    // A slow initial transfer/snapshot must not immediately repeat the same full bootstrap.
    if (bootstrapped && checkedVersion) bootstrapAt = Date.now()
    if (completeEmptyReview && joinReviewReady) {
      const review = joinReview()
      if (
        review.required &&
        !review.local.length &&
        !review.shared.some((row) => row.entityType === 'project' && !row.directoryPath)
      )
        return applyReview({ fingerprint: review.fingerprint, decisions: [] })
    }
    last.progress = undefined
    return status()
  }
  async function connect(input: ConnectFolderSync): Promise<FolderSyncState> {
    if (!input || (input.mode !== 'create' && input.mode !== 'join'))
      throw new AppError('SYNC_SETUP_REQUIRED', 'Choose Create or Join shared history.')
    const folder = checkedFolder(input.folder)
    const existing = connection()
    if (existing && (input.mode === 'create' || input.workspaceId !== existing.workspaceId))
      throw new AppError(
        'SYNC_WORKSPACE_ALREADY_CONNECTED',
        'This installation already retains a shared history. Choose its workspace to reconnect or relocate the folder.'
      )
    if (input.mode === 'create') {
      const found = listSyncWorkspaces(folder)
      if (found.issues.length) throw found.issues[0].error
      if (found.workspaces.length)
        throw new AppError(
          'SYNC_HISTORY_ARRIVED',
          'Shared history has arrived in this folder. Connect to that history instead.'
        )
    }
    const shared =
      input.mode === 'create'
        ? createSyncWorkspace(folder, input.name ?? 'My history')
        : openSyncWorkspace({ folder, workspaceId: input.workspaceId ?? '' })
    const db = options.db()
    db.transaction((tx) => {
      let policy = getWorkspacePolicy(tx)
      if (
        !policy &&
        (input.mode === 'create' || tx.select({ id: sessions.id }).from(sessions).limit(1).get())
      )
        policy = initializeWorkspacePolicy(
          tx,
          input.reportingTimeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone
        )
      tx.insert(folderSyncSettings)
        .values({
          slot: 1,
          workspaceId: shared.manifest.workspaceId,
          policyWorkspaceId: policy?.workspaceId ?? shared.manifest.workspaceId,
          folderPath: folder,
          enabled: 1
        })
        .onConflictDoUpdate({
          target: folderSyncSettings.slot,
          set: { folderPath: folder, enabled: existing?.enabled ?? 1, error: null }
        })
        .run()
      if (input.mode === 'create') {
        const initial = initialWorkspacePolicyChange(tx, shared.manifest.workspaceId)
        if (initial)
          recordLocalSyncChanges(
            tx,
            shared.manifest.workspaceId,
            [initial],
            workspacePolicySyncAdapter
          )
      } else if (!existing) {
        // First join with local clients/projects: import before exporting any possible duplicate.
        beginJoinReview(tx, shared.manifest.workspaceId)
      }
    })
    checkedVersion = undefined
    last = {
      ...emptyState(),
      workspaceId: shared.manifest.workspaceId,
      name: shared.manifest.name,
      status: 'incomplete'
    }
    return syncNow()
  }
  async function assertAvailableForBilling(): Promise<void> {
    const current = connection()
    if (!current) return
    if (!current.enabled)
      throw new AppError(
        'SYNC_BILLING_INCOMPLETE',
        'Resume shared history transfers before creating or sending an invoice.'
      )
    const result = await syncNow()
    if (transportBlocked || result.status === 'unavailable' || result.status === 'update-required')
      throw new AppError(
        'SYNC_BILLING_INCOMPLETE',
        'Available shared history could not be fully checked. Resolve its delivery issues before invoicing.'
      )
  }
  function joinReview(): FolderSyncJoinReview {
    const saved = connection()
    if (!saved) throw new AppError('SYNC_SETUP_REQUIRED', 'Choose a shared folder first.')
    return readJoinReview(options.db(), saved.workspaceId, options.device().deviceId)
  }
  /** Applies every explicit match atomically with the export it unblocks, then syncs. */
  async function applyReview(input: ApplyFolderSyncJoinReview): Promise<FolderSyncState> {
    const saved = connection()
    if (!saved) throw new AppError('SYNC_SETUP_REQUIRED', 'Choose a shared folder first.')
    if (isJoinReviewPending(options.db(), saved.workspaceId)) {
      const current = await syncNow(false)
      if (!current.joinReviewReady)
        throw new AppError(
          'SYNC_JOIN_HISTORY_INCOMPLETE',
          'Shared history is still loading. Wait for it to finish before connecting projects.'
        )
    }
    options.db().transaction((tx) => {
      applyJoinReview(tx, saved.workspaceId, input, options.device().deviceId)
      const directory = planDirectoryExport(tx, saved.workspaceId)
      recordLocalSyncChanges(tx, saved.workspaceId, directory.changes, directoryRecordsAdapter)
    })
    checkedVersion = undefined
    return syncNow()
  }
  async function setEnabled(enabled: boolean): Promise<FolderSyncState> {
    if (typeof enabled !== 'boolean' || !connection())
      throw new AppError('SYNC_SETUP_REQUIRED', 'Choose a shared folder first.')
    options
      .db()
      .update(folderSyncSettings)
      .set({ enabled: Number(enabled) })
      .where(eq(folderSyncSettings.slot, 1))
      .run()
    return enabled ? syncNow() : status()
  }
  return {
    status,
    discover,
    connect: (input: ConnectFolderSync) => exclusive(() => connect(input)),
    setEnabled: (enabled: boolean) => {
      if (!enabled) {
        generation++
        options.reads?.cancel()
      }
      return exclusive(() => setEnabled(enabled))
    },
    syncNow: () => (active ? queue.then(() => status()) : exclusive(() => syncNow())),
    assertAvailableForBilling: () => exclusive(assertAvailableForBilling),
    joinReview,
    applyJoinReview: (input: ApplyFolderSyncJoinReview) => exclusive(() => applyReview(input)),
    start() {
      if (!timer) {
        const tick = () => {
          if (timer && !active) void exclusive(() => syncNow()).catch(() => {})
        }
        timer = setInterval(tick, 30_000)
        timer.unref()
        setImmediate(tick)
      }
    },
    stop() {
      generation++
      options.reads?.cancel()
      if (timer) clearInterval(timer)
      timer = undefined
    }
  }
}
