import { app } from 'electron'
import { join } from 'node:path'
import { getDb } from '../db'
import { getLocalDeviceSession } from './device-context'
import { createFolderSyncCoordinator } from './folder-sync-coordinator'
import {
  projectSharedSessions,
  sharedSessionConversationKeys
} from './folder-sync-session-projection'
import { createSyncReadClient } from './folder-sync-read-client'

let service: ReturnType<typeof createFolderSyncCoordinator> | undefined
export function getFolderSyncService() {
  service ??= createFolderSyncCoordinator({
    db: getDb,
    device: getLocalDeviceSession,
    localDataDirectory: app.getPath('userData'),
    reads: createSyncReadClient(),
    databasePath: join(app.getPath('userData'), 'clautime.db'),
    project: async (db, workspaceId, yieldControl) => {
      const issues: import('../../shared/types/folder-sync').FolderSyncIssue[] = []
      for (const key of sharedSessionConversationKeys(db)) {
        await yieldControl()
        issues.push(
          ...projectSharedSessions(db, workspaceId, {
            deviceId: getLocalDeviceSession().deviceId,
            conversationKeys: [key]
          }).issues.map((issue) => ({
            source: issue.conversation,
            code: issue.code,
            message: issue.message
          }))
        )
      }
      return issues
    }
  })
  return service
}
export function stopFolderSync(): void {
  service?.stop()
}
