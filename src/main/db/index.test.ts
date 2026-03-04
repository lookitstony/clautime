// @vitest-environment node
import { describe, it, expect, afterAll } from 'vitest'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { join } from 'path'
import * as sessionsSchema from './schema/sessions'
import * as appSettingsSchema from './schema/app-settings'

const schema = { ...sessionsSchema, ...appSettingsSchema }

let sqlite: Database.Database

afterAll(() => {
  sqlite?.close()
})

describe('Database initialization', () => {
  it('creates in-memory database and runs migrations', () => {
    sqlite = new Database(':memory:')
    sqlite.pragma('journal_mode = WAL')
    const db = drizzle(sqlite, { schema })

    // Run migrations — should not throw
    migrate(db, { migrationsFolder: join(__dirname, './migrations') })

    // Verify tables exist by inserting and querying
    db.insert(sessionsSchema.sessions)
      .values({
        projectPath: '/test/project',
        startedAt: '2026-03-04T10:00:00Z',
        endedAt: '2026-03-04T11:00:00Z',
        durationMinutes: 60
      })
      .run()

    const rows = db.select().from(sessionsSchema.sessions).all()
    expect(rows).toHaveLength(1)
    expect(rows[0].projectPath).toBe('/test/project')
    expect(rows[0].durationMinutes).toBe(60)
    expect(rows[0].source).toBe('auto')
    expect(rows[0].status).toBe('completed')
  })

  it('creates app_settings table with key-value storage', () => {
    const db = drizzle(sqlite, { schema })

    db.insert(appSettingsSchema.appSettings)
      .values({ key: 'test_key', value: 'test_value' })
      .run()

    const rows = db.select().from(appSettingsSchema.appSettings).all()
    const setting = rows.find((r) => r.key === 'test_key')
    expect(setting?.value).toBe('test_value')
    expect(setting?.updatedAt).toBeDefined()
  })

  it('enforces sessions indexes without error', () => {
    const db = drizzle(sqlite, { schema })

    // Insert multiple rows to exercise indexes
    for (let i = 0; i < 5; i++) {
      db.insert(sessionsSchema.sessions)
        .values({
          projectPath: `/project-${i}`,
          startedAt: `2026-03-04T${10 + i}:00:00Z`,
          endedAt: `2026-03-04T${11 + i}:00:00Z`,
          durationMinutes: 60
        })
        .run()
    }

    const rows = db.select().from(sessionsSchema.sessions).all()
    expect(rows.length).toBeGreaterThanOrEqual(6) // 1 from previous test + 5
  })
})
