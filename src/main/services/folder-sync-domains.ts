import { isInvoiceEntityType, invoiceRecordsAdapter } from './folder-sync-invoice-records'
import { historyObserversAdapter } from './folder-sync-history-observers'
import { sessionRecordsAdapter, isSessionRecordEntityType } from './folder-sync-session-records'
import { historyRecordsAdapter, HISTORY_SYNC_ENTITY_TYPES } from './folder-sync-history-records'
import {
  deferredLegacyAdapter,
  legacyRecordsAdapter,
  LEGACY_SYNC_ENTITY_TYPES
} from './folder-sync-legacy-records'
import { manualRecordsAdapter } from './folder-sync-manual-records'
import { machineLabelSyncAdapter } from './folder-sync-machine-records'
import { activitySyncAdapter, ACTIVITY_SYNC_ENTITY_TYPES } from './folder-sync-activity-records'
import { directoryRecordsAdapter, isDirectoryEntityType } from './folder-sync-directory-records'
import { workspacePolicySyncAdapter } from './folder-sync-policy-records'
import { SyncError, type SyncChange } from './folder-sync-protocol'
import type { SyncDomainAdapter } from './folder-sync-store'

/** Closed routing: knowing a transport entity name never permits unvalidated payloads. */
function adapter(change: SyncChange): SyncDomainAdapter {
  if ((ACTIVITY_SYNC_ENTITY_TYPES as readonly string[]).includes(change.entityType))
    return activitySyncAdapter
  if (isDirectoryEntityType(change.entityType)) return directoryRecordsAdapter
  if (isSessionRecordEntityType(change.entityType)) return sessionRecordsAdapter
  if ((HISTORY_SYNC_ENTITY_TYPES as readonly string[]).includes(change.entityType))
    return historyRecordsAdapter
  if ((LEGACY_SYNC_ENTITY_TYPES as readonly string[]).includes(change.entityType))
    return legacyRecordsAdapter
  if (isInvoiceEntityType(change.entityType)) return invoiceRecordsAdapter
  if (change.entityType === 'history-observer') return historyObserversAdapter
  if (change.entityType === 'manual-entry') return manualRecordsAdapter
  if (change.entityType === 'machine-label') return machineLabelSyncAdapter
  if (change.entityType === 'workspace-policy') return workspacePolicySyncAdapter
  throw new SyncError(
    'SYNC_UPDATE_REQUIRED',
    `This build cannot import shared ${change.entityType} records.`
  )
}

export const folderSyncAdapter: SyncDomainAdapter = {
  validate: (change) => adapter(change).validate(change),
  apply: (tx, workspaceId, change) => adapter(change).apply(tx, workspaceId, change),
  forBatch: () => {
    const legacy = deferredLegacyAdapter()
    return {
      validate: folderSyncAdapter.validate,
      apply: (tx, workspaceId, change) => {
        const domain = adapter(change)
        if (domain === legacyRecordsAdapter) legacy.adapter.apply(tx, workspaceId, change)
        else {
          // Billing and other domains must see the preceding legacy changes' derived state.
          legacy.flush(tx, workspaceId)
          domain.apply(tx, workspaceId, change)
        }
      },
      flush: legacy.flush
    }
  }
}
