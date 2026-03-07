import { join } from 'path'
import { app } from 'electron'
import Database from 'better-sqlite3'
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import log from 'electron-log/main.js'
import * as sessionsSchema from './schema/sessions'
import * as appSettingsSchema from './schema/app-settings'
import * as scanStateSchema from './schema/scan-state'
import * as clientsSchema from './schema/clients'
import * as projectsSchema from './schema/projects'
import * as gitCommitsSchema from './schema/git-commits'
import * as aiSummariesSchema from './schema/ai-summaries'
import * as projectAlertConfigSchema from './schema/project-alert-config'
import * as rawMessagesSchema from './schema/raw-messages'

const schema = {
  ...sessionsSchema,
  ...appSettingsSchema,
  ...scanStateSchema,
  ...clientsSchema,
  ...projectsSchema,
  ...gitCommitsSchema,
  ...aiSummariesSchema,
  ...projectAlertConfigSchema,
  ...rawMessagesSchema
}

let db: BetterSQLite3Database<typeof schema>
let sqlite: Database.Database

/**
 * Initialize the SQLite database and run Drizzle migrations.
 * MUST be called before any window is created.
 */
export function initializeDatabase(): void {
  const dbPath = join(app.getPath('userData'), 'clawdtime.db')
  log.info(`Initializing database at: ${dbPath}`)

  sqlite = new Database(dbPath)
  sqlite.pragma('journal_mode = WAL')

  db = drizzle(sqlite, { schema })

  // Resolve migrations folder — works in both dev and packaged builds
  const migrationsFolder = join(__dirname, '../../src/main/db/migrations')
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
