// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { join } from 'path'
import * as sessionsSchema from '../db/schema/sessions'
import * as appSettingsSchema from '../db/schema/app-settings'

// We need to mock getDb since it depends on Electron's app.getPath
// Instead, we test the service logic directly with an in-memory DB
const schema = { ...sessionsSchema, ...appSettingsSchema }

let sqlite: Database.Database
let db: ReturnType<typeof drizzle<typeof schema>>

beforeAll(() => {
  sqlite = new Database(':memory:')
  sqlite.pragma('journal_mode = WAL')
  db = drizzle(sqlite, { schema })
  migrate(db, { migrationsFolder: join(__dirname, '../db/migrations') })
})

afterAll(() => {
  sqlite.close()
})

// Direct DB tests for settings CRUD (same logic as SettingsService)
describe('SettingsService logic', () => {
  it('inserts and retrieves a setting', () => {
    db.insert(appSettingsSchema.appSettings)
      .values({ key: 'idle_timeout', value: '10' })
      .run()

    const row = db
      .select()
      .from(appSettingsSchema.appSettings)
      .where(
        // eslint-disable-next-line drizzle/enforce-delete-with-where
        undefined as never
      )
      .all()
      .find((r) => r.key === 'idle_timeout')

    expect(row?.value).toBe('10')
  })

  it('upserts a setting on conflict', () => {
    db.insert(appSettingsSchema.appSettings)
      .values({ key: 'idle_timeout', value: '15', updatedAt: new Date().toISOString() })
      .onConflictDoUpdate({
        target: appSettingsSchema.appSettings.key,
        set: { value: '15', updatedAt: new Date().toISOString() }
      })
      .run()

    const rows = db.select().from(appSettingsSchema.appSettings).all()
    const row = rows.find((r) => r.key === 'idle_timeout')
    expect(row?.value).toBe('15')
  })

  it('retrieves all settings', () => {
    db.insert(appSettingsSchema.appSettings)
      .values({ key: 'theme', value: 'teal' })
      .run()

    const rows = db.select().from(appSettingsSchema.appSettings).all()
    expect(rows.length).toBeGreaterThanOrEqual(2)
  })
})
