// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { appSettings } from '../db/schema/app-settings'
import { adoptInitialWorkspacePolicy } from './workspace-policy'
import { settingsService } from './settings-service'
import { reviewWorkspacePolicy, reviewWorkspaceActivityAdoption } from './workspace-review'
import { sessions } from '../db/schema/sessions'

vi.mock('../db', () => ({ getDb: () => db }))
vi.mock('electron-log/main.js', () => ({ default: { debug: vi.fn() } }))
let sqlite: Database.Database
let db: ReturnType<typeof drizzle>
const policy = {
  version: 1,
  normalizationVersion: 1,
  detectorVersion: 1,
  idleTimeoutMinutes: 20,
  reportingTimeZone: 'UTC'
}
beforeEach(() => {
  sqlite = new Database(':memory:')
  sqlite.pragma('foreign_keys = ON')
  db = drizzle(sqlite)
  migrate(db, { migrationsFolder: join(__dirname, '../db/migrations') })
})
afterEach(() => sqlite.close())

it('uses local settings before setup and requires reviewed changes after adopting workspace policy', () => {
  settingsService.setSetting('idle_timeout_minutes', '5')
  expect(settingsService.getSetting('idle_timeout_minutes')).toBe('5')
  adoptInitialWorkspacePolicy(db, { workspaceId: randomUUID(), revisionId: randomUUID(), policy })
  expect(settingsService.getSetting('idle_timeout_minutes')).toBe('20')
  expect(settingsService.getAllSettings().idle_timeout_minutes).toBe('20')
  const before = sqlite.serialize()
  expect(() => settingsService.setSetting('idle_timeout_minutes', '10')).toThrow(
    /shared tracking policy/
  )
  expect(sqlite.serialize()).toEqual(before)
  expect(db.select().from(appSettings).get()?.value).toBe('5')
  settingsService.setSetting('theme', 'teal')
  expect(settingsService.getSetting('theme')).toBe('teal')
})

it('shows source-less saved history as held without exposing unrelated settings or allowing adoption', () => {
  adoptInitialWorkspacePolicy(db, { workspaceId: randomUUID(), revisionId: randomUUID(), policy })
  settingsService.setSetting('private-fixture', 'not-for-renderer-review')
  const row = db
    .insert(sessions)
    .values({
      projectPath: 'fixture',
      startedAt: '2026-09-26T10:00:00Z',
      endedAt: '2026-09-26T10:10:00Z',
      durationMinutes: 10
    })
    .returning()
    .get()
  const before = sqlite.serialize()
  const review = reviewWorkspacePolicy(db, {
    candidate: {
      ...policy,
      version: 1,
      normalizationVersion: 1,
      detectorVersion: 1,
      idleTimeoutMinutes: 10
    }
  })
  expect(review.retainedWithoutActivity).toEqual([row.id])
  expect(review.heldKeys).toEqual([`saved:${row.id}`])
  expect(JSON.stringify(review)).not.toContain('not-for-renderer-review')
  expect(reviewWorkspaceActivityAdoption(db).rows).toMatchObject([
    { sessionId: row.id, eligible: false, adopted: false }
  ])
  expect(sqlite.serialize()).toEqual(before)
})
