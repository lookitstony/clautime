import { join } from 'path'
import { existsSync, renameSync } from 'fs'
import { app } from 'electron'
import { is } from '@electron-toolkit/utils'
import Database from 'better-sqlite3'
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import log from 'electron-log/main.js'
import * as sessionsSchema from './schema/sessions'
import * as providerOperationsSchema from './schema/provider-operations'
import * as folderSyncSchema from './schema/folder-sync'
import * as appSettingsSchema from './schema/app-settings'
import * as scanStateSchema from './schema/scan-state'
import * as clientsSchema from './schema/clients'
import * as projectsSchema from './schema/projects'
import * as gitCommitsSchema from './schema/git-commits'
import * as aiSummariesSchema from './schema/ai-summaries'
import * as projectAlertConfigSchema from './schema/project-alert-config'
import * as rawMessagesSchema from './schema/raw-messages'
import * as secretFindingsSchema from './schema/secret-findings'
import * as invoicesSchema from './schema/invoices'
import * as sessionModelUsageSchema from './schema/session-model-usage'
import * as sessionDerivationsSchema from './schema/session-derivations'
import * as sessionDeletionsSchema from './schema/session-deletions'
import * as sessionHistorySchema from './schema/session-history'
import * as sessionReconciliationSchema from './schema/session-reconciliation'
import * as sessionLegacySchema from './schema/session-legacy'
import * as activityEvidenceSchema from './schema/activity-evidence'
import * as projectFolderMappingsSchema from './schema/project-folder-mappings'
import * as localProjectSetupSchema from './schema/local-project-setup'
import * as manualTimeEntriesSchema from './schema/manual-time-entries'
import * as workspacePolicySchema from './schema/workspace-policy'
import * as sessionActivityMappingSchema from './schema/session-activity-mappings'
import * as sessionMappingRevisionSchema from './schema/session-mapping-revisions'
import * as activityObserversSchema from './schema/activity-observers'
import * as localFolderDiscoveryBlocksSchema from './schema/local-folder-discovery-blocks'
import * as syncLegacySchema from './schema/sync-legacy'

const schema = {
  ...providerOperationsSchema,
  ...folderSyncSchema,
  ...sessionsSchema,
  ...appSettingsSchema,
  ...scanStateSchema,
  ...clientsSchema,
  ...projectsSchema,
  ...gitCommitsSchema,
  ...aiSummariesSchema,
  ...projectAlertConfigSchema,
  ...rawMessagesSchema,
  ...secretFindingsSchema,
  ...invoicesSchema,
  ...sessionModelUsageSchema,
  ...sessionDerivationsSchema,
  ...sessionDeletionsSchema,
  ...sessionHistorySchema,
  ...sessionReconciliationSchema,
  ...sessionLegacySchema,
  ...activityEvidenceSchema,
  ...projectFolderMappingsSchema,
  ...localProjectSetupSchema,
  ...localFolderDiscoveryBlocksSchema,
  ...activityObserversSchema,
  ...manualTimeEntriesSchema,
  ...workspacePolicySchema,
  ...sessionActivityMappingSchema,
  ...sessionMappingRevisionSchema,
  ...syncLegacySchema
}

let db: BetterSQLite3Database<typeof schema>
let sqlite: Database.Database

/**
 * Initialize the SQLite database and run Drizzle migrations.
 * MUST be called before any window is created.
 */
export function initializeDatabase(): void {
  const dbPath = join(app.getPath('userData'), 'clautime.db')

  // Migrate from old ClawdTime userData folder if it exists
  // Electron derives the userData folder from package.json "name", so renaming
  // the package from "clawdtime" to "clautime" changed the folder path too.
  const userDataDir = app.getPath('userData')
  const oldUserDataDir = join(userDataDir, '..', 'clawdtime')
  const oldDbPath = join(oldUserDataDir, 'clawdtime.db')
  if (!existsSync(dbPath) && existsSync(oldDbPath)) {
    log.info(`Migrating database from ${oldDbPath} to ${dbPath}`)
    renameSync(oldDbPath, dbPath)
    // Also migrate WAL/SHM files if present
    for (const ext of ['-wal', '-shm']) {
      if (existsSync(oldDbPath + ext)) {
        renameSync(oldDbPath + ext, dbPath + ext)
      }
    }
  }

  log.info(`Initializing database at: ${dbPath}`)

  sqlite = new Database(dbPath)
  sqlite.pragma('journal_mode = WAL')

  db = drizzle(sqlite, { schema })

  // Resolve migrations folder — dev uses source path, packaged uses extraResources
  const migrationsFolder = is.dev
    ? join(__dirname, '../../src/main/db/migrations')
    : join(process.resourcesPath, 'migrations')
  log.info(`Running migrations from: ${migrationsFolder}`)

  migrate(db, { migrationsFolder })
  log.info('Database initialized successfully')
}

/** Get the Drizzle database instance. Throws if not initialized. */
export function getDb(): BetterSQLite3Database<typeof schema> {
  if (!db) {
    throw new Error('Database not initialized. Call initializeDatabase() first.')
  }
  return db
}

/** Close the database connection. Call on app quit. */
export function closeDatabase(): void {
  if (sqlite) {
    sqlite.close()
    log.info('Database connection closed')
  }
}
