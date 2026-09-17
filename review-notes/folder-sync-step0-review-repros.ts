// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { appendFile, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import Database from 'better-sqlite3'
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { sessions } from '../db/schema/sessions'
import { sessionModelUsage } from '../db/schema/session-model-usage'
import { rawMessages } from '../db/schema/raw-messages'
import { setCustomExcludedPaths } from '../../shared/paths'

vi.mock('electron-log/main.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
}))
let db: BetterSQLite3Database
let sqlite: Database.Database
let fixture: string
const settings: Record<string, string> = {}
vi.mock('../db', () => ({ getDb: () => db }))
vi.mock('./settings-service', () => ({
  settingsService: {
    getSetting: (key: string) => settings[key] ?? null,
    setSetting: (key: string, value: string) => {
      settings[key] = value
    }
  }
}))
// Only discover the disposable fixture tree; parsing and filesystem I/O are real.
vi.mock('../providers', async () => {
  const { discoverSessionFiles, parseSessionFile } = await import('../parsers/session-parser')
  const provider = {
    id: 'claude',
    discoverFiles: ({ rootOverride }: { rootOverride: string }) =>
      discoverSessionFiles(rootOverride ?? fixture),
    parseFile: parseSessionFile
  }
  return {
    providerRegistry: [provider],
    enabledProviders: () => (settings.track_claude === 'false' ? [] : [provider]),
    providerForFile: () => provider
  }
})
import { sessionService } from './session-service'

function openFixture(): void {
  sqlite = new Database(join(fixture, 'history.db'))
  sqlite.pragma('foreign_keys = ON')
  db = drizzle(sqlite)
  migrate(db, { migrationsFolder: join(__dirname, '../db/migrations') })
}

function event(uuid: string, timestamp: string, outputTokens = 0): string {
  return (
    JSON.stringify({
      type: outputTokens ? 'assistant' : 'user',
      uuid,
      timestamp,
      sessionId: 'fixture-session',
      cwd: 'C:\\projects\\retained',
      message: outputTokens
        ? {
            role: 'assistant',
            model: 'fixture-model',
            content: [{ type: 'text', text: 'Fixture reply' }],
            usage: {
              input_tokens: 100,
              output_tokens: outputTokens,
              cache_read_input_tokens: 50,
              cache_creation_input_tokens: 25
            }
          }
        : { role: 'user', content: 'Fixture prompt' }
    }) + '\n'
  )
}

beforeEach(async () => {
  fixture = await mkdtemp(join(tmpdir(), 'clautime-retention-'))
  for (const key of Object.keys(settings)) delete settings[key]
  setCustomExcludedPaths([])
  openFixture()
})
afterEach(async () => {
  sqlite.close()
  setCustomExcludedPaths([])
  const target = resolve(fixture)
  if (!target.startsWith(resolve(tmpdir()) + sep) || !target.includes('clautime-retention-')) {
    throw new Error('Unexpected fixture cleanup path')
  }
  await rm(target, { recursive: true, force: true })
})


function captured(sourceFile: string, uuid: string, timestamp: string) {
  db.insert(rawMessages).values({ sourceFile, uuid, timestamp, type: 'user', claudeSessionId: 'fixture-session', cwd: 'C:\\projects\\retained' }).run()
}

describe('Step 0 independent review reproductions', () => {
  it('preserves explicit time edits after automatic measurements catch up and grow again', async () => {
    captured('/review/edited.jsonl', 'one', '2026-03-04T10:00:00Z')
    captured('/review/edited.jsonl', 'two', '2026-03-04T10:05:00Z')
    await sessionService.rebuildSessionsFromRaw()
    const original = db.select().from(sessions).get()!
    sessionService.updateSession(original.id, { endedAt: '2026-03-04T10:20:00Z', durationMinutes: 20 })
    captured('/review/edited.jsonl', 'three', '2026-03-04T10:15:00Z')
    captured('/review/edited.jsonl', 'four', '2026-03-04T10:20:00Z')
    await sessionService.rebuildSessionsFromRaw()
    expect(db.select().from(sessions).get()?.durationMinutes).toBe(20)
    captured('/review/edited.jsonl', 'five', '2026-03-04T10:25:00Z')
    await sessionService.rebuildSessionsFromRaw()
    expect(db.select().from(sessions).get()?.durationMinutes).toBe(20)
  })

  it('retains captured subagent tokens when only the main log remains and grows', async () => {
    const directory = join(fixture, 'projects', 'C--projects-retained')
    const subDirectory = join(directory, 'fixture-session', 'subagents')
    await mkdir(subDirectory, { recursive: true })
    const main = join(directory, 'fixture-session.jsonl')
    const sub = join(subDirectory, 'agent-review.jsonl')
    await writeFile(main, event('p', '2026-03-04T10:00:00Z') + event('a', '2026-03-04T10:05:00Z', 50))
    await writeFile(sub, event('sub-a', '2026-03-04T10:03:00Z', 75))
    await sessionService.scanAndRebuild()
    const original = db.select().from(sessions).get()!
    expect(original.inputTokens).toBe(200)
    const usage = db.select().from(sessionModelUsage).all()
    await rm(sub)
    await appendFile(main, event('p2', '2026-03-04T10:10:00Z'))
    await sessionService.scanSessions(fixture)
    expect(db.select().from(rawMessages).all().filter((r) => r.isSubagent === 1)).toHaveLength(1)
    expect(db.select().from(sessions).get()?.inputTokens).toBe(200)
    expect(db.select().from(sessionModelUsage).all()).toEqual(usage)
  })

  it('allows unrelated captured history to reconcile despite one legacy mismatch', async () => {
    db.insert(sessions).values({ sourceFile: '/review/a-legacy.jsonl', claudeSessionId: 'fixture-session', projectPath: 'C:\\projects\\retained', startedAt: '2026-03-04T10:00:00Z', endedAt: '2026-03-04T10:05:00Z', durationMinutes: 5, inputTokens: 1000 }).run()
    captured('/review/a-legacy.jsonl', 'old', '2026-03-04T10:00:00Z')
    captured('/review/b-healthy.jsonl', 'new', '2026-03-04T11:00:00Z')
    await expect(sessionService.rebuildSessionsFromRaw()).rejects.toThrow(/reconciliation/)
    expect(db.select().from(sessions).all().some((row) => row.sourceFile === '/review/b-healthy.jsonl')).toBe(true)
  })
})
