// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { appendFile, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import Database from 'better-sqlite3'
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { removeClientProjectSyncIds } from '../db/migration-test-helpers'
import { sessions } from '../db/schema/sessions'
import { sessionModelUsage } from '../db/schema/session-model-usage'
import { rawMessages, progressEvents } from '../db/schema/raw-messages'
import {
  activityIdentities,
  activityObservations,
  activitySources
} from '../db/schema/activity-evidence'
import { scanState } from '../db/schema/scan-state'
import { sessionDerivations, sessionTimeOverrides } from '../db/schema/session-derivations'
import { sessionLegacyRecords } from '../db/schema/session-legacy'
import { sessionDeletions } from '../db/schema/session-deletions'
import { sessionSplits } from '../db/schema/session-history'
import { clients } from '../db/schema/clients'
import { invoices, invoiceLineItems } from '../db/schema/invoices'
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

describe('retention with real source files and a restarted database', () => {
  it('persists progress-only scan tails from main and subagent logs without adding messages', async () => {
    const directory = join(fixture, 'projects', 'C--projects-retained')
    await mkdir(directory, { recursive: true })
    const sourceFile = join(directory, 'fixture-session.jsonl')
    await writeFile(sourceFile, event('first', '2026-03-04T10:00:00.000Z'))
    expect((await sessionService.scanAndRebuild()).errors).toBeUndefined()
    const savedMessages = db.select().from(rawMessages).all()
    const progress = (uuid: string) =>
      JSON.stringify({
        type: 'progress',
        sessionId: 'fixture-session',
        uuid,
        parentUuid: 'first',
        timestamp: '2026-03-04T10:00:01.000Z',
        data: { type: 'bash_progress', output: 'PRIVATE' }
      }) + '\n'
    const subdir = join(directory, 'fixture-session', 'subagents')
    await mkdir(subdir, { recursive: true })
    const agent = join(subdir, 'agent-progress.jsonl')
    await writeFile(agent, progress('agent-tick'))
    await appendFile(sourceFile, progress('main-tick'))
    expect((await sessionService.scanSessions()).errors).toBeUndefined()
    expect(db.select().from(rawMessages).all()).toEqual(savedMessages)
    expect(db.select().from(progressEvents).all()).toHaveLength(2)
    expect(db.select().from(activityIdentities).all()).toHaveLength(3)
    const observations = db
      .select()
      .from(activityObservations)
      .orderBy(activityObservations.id)
      .all()
    expect(observations.filter((row) => row.kind === 'activity')).toHaveLength(2)
    expect(JSON.stringify(observations)).not.toContain('PRIVATE')
    const sources = db.select().from(activitySources).all()
    expect(sources.some((source) => source.sourceFile === agent && source.isSubagent === 1)).toBe(
      true
    )
    await sessionService.scanSessions()
    expect(db.select().from(activityObservations).orderBy(activityObservations.id).all()).toEqual(
      observations
    )
    await rm(agent)
    await rm(sourceFile)
    sqlite.close()
    openFixture()
    await sessionService.scanAndRebuild()
    expect(db.select().from(activityObservations).orderBy(activityObservations.id).all()).toEqual(
      observations
    )
    expect(db.select().from(rawMessages).all()).toEqual(savedMessages)
  })

  it('captures existing source identities after migration resets consumed offsets', async () => {
    const directory = join(fixture, 'projects', 'C--projects-retained')
    await mkdir(directory, { recursive: true })
    const sourceFile = join(directory, 'identity-upgrade.jsonl')
    await writeFile(
      sourceFile,
      event('first', '2026-03-04T10:00:00.000Z') + event('reply', '2026-03-04T10:10:00.000Z', 20)
    )
    expect((await sessionService.scanAndRebuild()).errors).toBeUndefined()
    const before = sessionService.getAllSessions()
    expect(before).toHaveLength(1)
    expect(db.select().from(activityIdentities).all()).toHaveLength(2)
    // Simulate upgrading an installation whose raw history predates identity capture.
    removeClientProjectSyncIds(sqlite)
    sqlite.exec(
      'DROP TABLE activity_sources; DROP TABLE activity_observations; DROP TABLE activity_identities'
    )
    sqlite.prepare('DELETE FROM __drizzle_migrations WHERE created_at = ?').run(1789603200007)
    migrate(db, { migrationsFolder: join(__dirname, '../db/migrations') })
    expect(db.select().from(activityIdentities).all()).toHaveLength(0)
    const scan = await sessionService.scanSessions(fixture)
    expect(scan.errors).toBeUndefined()
    expect(scan.updatedFiles).toBe(1)
    expect(db.select().from(activityIdentities).all()).toHaveLength(2)
    expect(sessionService.getAllSessions()[0]).toMatchObject({
      id: before[0].id,
      durationMinutes: before[0].durationMinutes,
      inputTokens: before[0].inputTokens,
      outputTokens: before[0].outputTokens
    })
    const observations = db.select().from(activityObservations).all()
    await rm(sourceFile)
    sqlite.close()
    openFixture()
    expect((await sessionService.scanAndRebuild()).errors).toBeUndefined()
    expect(db.select().from(activityObservations).all()).toEqual(observations)
    expect(sessionService.getAllSessions()[0].id).toBe(before[0].id)
  })

  it('rolls identity evidence back when raw-message storage fails and captures it on retry', async () => {
    const directory = join(fixture, 'projects', 'C--projects-retained')
    await mkdir(directory, { recursive: true })
    const sourceFile = join(directory, 'identity-atomic.jsonl')
    await writeFile(
      sourceFile,
      event('first', '2026-03-04T10:00:00.000Z') + event('reply', '2026-03-04T10:10:00.000Z', 20)
    )
    expect((await sessionService.scanAndRebuild()).errors).toBeUndefined()
    const observations = db.select().from(activityObservations).all()
    const sources = db.select().from(activitySources).all()
    const offsets = db.select().from(scanState).all()
    await appendFile(sourceFile, event('fail-write', '2026-03-04T10:11:00.000Z', 30))
    sqlite.exec(
      "CREATE TRIGGER fail_raw_write BEFORE INSERT ON raw_messages WHEN NEW.uuid = 'fail-write' BEGIN SELECT RAISE(ABORT, 'fixture-write-failed'); END"
    )
    await expect(sessionService.scanSessions(fixture)).rejects.toThrow()
    expect(db.select().from(activityObservations).all()).toEqual(observations)
    expect(db.select().from(activitySources).all()).toEqual(sources)
    expect(db.select().from(activityIdentities).all()).toHaveLength(2)
    expect(db.select().from(scanState).all()).toEqual(offsets)
    sqlite.exec('DROP TRIGGER fail_raw_write')
    expect((await sessionService.scanSessions(fixture)).errors).toBeUndefined()
    expect(db.select().from(activityIdentities).all()).toHaveLength(3)
    expect(sqlite.prepare('PRAGMA foreign_key_check').all()).toEqual([])
  })

  it('adopts source-less legacy history from real logs and retains the mapping after source removal', async () => {
    const directory = join(fixture, 'projects', 'C--projects-retained')
    await mkdir(directory, { recursive: true })
    const sourceFile = join(directory, 'returned.jsonl')
    const original = db
      .insert(sessions)
      .values({
        sourceFile: null,
        claudeSessionId: 'fixture-session',
        projectPath: 'C:\\projects\\retained',
        startedAt: '2026-03-04T09:55:00.000Z',
        endedAt: '2026-03-04T10:10:00.000Z',
        durationMinutes: 37,
        description: 'Keep legacy edit',
        billable: 0,
        inputTokens: 900
      })
      .returning()
      .get()
    db.insert(sessionModelUsage)
      .values({ sessionId: original.id, model: 'legacy-model', inputTokens: 900 })
      .run()
    const prefix =
      event('first', '2026-03-04T10:00:00.000Z') + event('reply', '2026-03-04T10:10:00.000Z', 200)
    await writeFile(sourceFile, prefix)
    // First-run backfill captures raw messages; rebuild performs its initial reconciliation.
    expect((await sessionService.scanAndRebuild()).errors).toHaveLength(1)
    expect(db.select().from(sessions).all()).toEqual([original])
    const review = sessionService.getReconciliationCases()[0]
    sessionService.mapSavedHistory(sourceFile, review.fingerprint!, [
      { sessionId: original.id, detectedIndex: 0 }
    ])
    expect((await sessionService.scanSessions(fixture)).errors).toBeUndefined()
    expect(sessionService.getAllSessions()).toEqual([
      expect.objectContaining({
        id: original.id,
        sourceFile,
        inputTokens: 100,
        outputTokens: 200,
        durationMinutes: 37,
        billable: 0
      })
    ])
    const saved = sessionService.getAllSessions()
    const usage = sessionService.getModelUsage()
    await rm(sourceFile)
    sqlite.close()
    openFixture()
    settings.track_claude = 'false'
    await sessionService.scanSessions(fixture)
    await sessionService.rebuildSessionsFromRaw()
    expect(sessionService.getAllSessions()).toEqual(saved)
    expect(sessionService.getModelUsage()).toEqual(usage)
    expect(db.select().from(sessionLegacyRecords).get()?.session).toEqual(original)
    settings.track_claude = 'true'
    await writeFile(sourceFile, prefix + event('later', '2026-03-04T10:15:00.000Z'))
    expect((await sessionService.scanSessions(fixture)).errors).toBeUndefined()
    expect(sessionService.getAllSessions()).toEqual([
      expect.objectContaining({
        id: original.id,
        sourceFile,
        promptCount: 2,
        inputTokens: 100,
        outputTokens: 200,
        durationMinutes: 37
      })
    ])
    expect(sqlite.prepare('PRAGMA foreign_key_check').all()).toEqual([])
  })

  it.each([true, false])(
    'migrates legacy snapshots and preserves deletion, usage and invoice audit across restart (source path: %s)',
    async (hasSourcePath) => {
      const client = db
        .insert(clients)
        .values({ name: 'Legacy fixture', color: 'var(--project-1)' })
        .returning()
        .get()
      sqlite.exec('ALTER TABLE session_splits DROP COLUMN legacy_record_id')
      sqlite.exec(
        'ALTER TABLE session_deletions DROP COLUMN legacy_record_id; DROP TABLE session_legacy_records'
      )
      sqlite.exec('ALTER TABLE session_billing_refs DROP COLUMN billed_ranges')
      sqlite.exec('DROP TABLE session_replacements')
      removeClientProjectSyncIds(sqlite)
      sqlite.exec(
        'DROP TABLE activity_sources; DROP TABLE activity_observations; DROP TABLE activity_identities'
      )
      sqlite.prepare('DELETE FROM __drizzle_migrations WHERE created_at >= ?').run(1789603200003)
      const directory = join(fixture, 'projects', 'C--projects-retained')
      await mkdir(directory, { recursive: true })
      const file = join(directory, 'legacy.jsonl')
      const original = db
        .insert(sessions)
        .values({
          clientId: client.id,
          projectPath: 'C:\\projects\\retained',
          sourceFile: hasSourcePath ? file : null,
          claudeSessionId: 'fixture-session',
          startedAt: '2026-03-04T08:00:00Z',
          endedAt: '2026-03-04T09:00:00Z',
          durationMinutes: 60,
          promptCount: 12,
          inputTokens: 3000,
          outputTokens: 500,
          description: 'Original legacy description',
          billable: 0
        })
        .returning()
        .get()
      const unknown = db
        .insert(sessions)
        .values({ ...original, id: undefined, sourceFile: null })
        .returning()
        .get()
      db.insert(sessions)
        .values({ ...original, id: undefined, source: 'manual' })
        .run()
      const mapped = db
        .insert(sessions)
        .values({ ...original, id: undefined })
        .returning()
        .get()
      db.insert(sessionDerivations)
        .values({
          sessionId: mapped.id,
          startedAt: mapped.startedAt,
          endedAt: mapped.endedAt,
          durationMinutes: mapped.durationMinutes
        })
        .run()
      db.insert(sessionModelUsage)
        .values({
          sessionId: original.id,
          model: 'legacy-model',
          inputTokens: 3000,
          outputTokens: 500,
          cacheCreationInputTokens: 41,
          cacheReadInputTokens: 82
        })
        .run()
      const invoice = sqlite
        .prepare(
          'INSERT INTO invoices (client_id, stripe_invoice_id, amount_due_cents, created_at, updated_at) VALUES (?, ?, ?, ?, ?) RETURNING id'
        )
        .get(client.id, 'in_legacy', 10000, new Date().toISOString(), new Date().toISOString()) as {
        id: number
      }
      db.insert(invoiceLineItems)
        .values({
          invoiceId: invoice.id,
          description: 'Original invoice',
          amountCents: 10000,
          sessionIds: String(original.id)
        })
        .run()
      const lines = db.select().from(invoiceLineItems).all()
      const savedRows = db.select().from(sessions).all()
      migrate(db, { migrationsFolder: join(__dirname, '../db/migrations') })
      const invoiceAfterMigration = db.select().from(invoices).get()!
      expect(invoiceAfterMigration).toMatchObject({
        id: invoice.id,
        stripeInvoiceId: 'in_legacy',
        amountDueCents: 10000
      })
      const snapshots = db.select().from(sessionLegacyRecords).all()
      expect(snapshots).toHaveLength(2)
      const retained = snapshots.find((row) => row.sessionId === original.id)!
      expect(retained.id).toMatch(
        /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/
      )
      expect(retained).toMatchObject({
        version: 1,
        session: original,
        modelUsage: [
          {
            model: 'legacy-model',
            inputTokens: 3000,
            outputTokens: 500,
            cacheCreationInputTokens: 41,
            cacheReadInputTokens: 82
          }
        ]
      })
      expect(snapshots.find((row) => row.sessionId === unknown.id)?.modelUsage).toEqual([])
      expect(db.select().from(sessions).all()).toEqual(savedRows)
      expect(db.select().from(rawMessages).all()).toEqual([])
      sessionService.updateSession(original.id, {
        description: 'Later user edit',
        durationMinutes: 75
      })
      sessionService.deleteSession(original.id)
      expect(db.select().from(sessionDeletions).get()?.legacyRecordId).toBe(retained.id)
      sqlite.close()
      openFixture()
      expect(db.select().from(sessionLegacyRecords).all()).toEqual(snapshots)
      expect(db.select().from(invoiceLineItems).all()).toEqual(lines)
      expect(db.select().from(invoices).get()).toEqual(invoiceAfterMigration)
      expect(sessionService.getSessionById(original.id)).toBeNull()
      await writeFile(
        file,
        event('returning', '2026-03-04T10:00:00Z') + event('reply', '2026-03-04T10:05:00Z', 50)
      )
      expect((await sessionService.scanAndRebuild()).errors).toEqual([
        expect.objectContaining({ sourceFile: file })
      ])
      expect(sessionService.getSessionById(original.id)).toBeNull()
      expect(db.select().from(sessionLegacyRecords).all()).toEqual(snapshots)
      expect(db.select().from(invoiceLineItems).all()).toEqual(lines)
    }
  )

  it('holds real returning conversations for a source-less deletion through keep, restart and another file path', async () => {
    const row = db
      .insert(sessions)
      .values({
        projectPath: 'C:\\projects\\retained',
        claudeSessionId: 'fixture-session',
        startedAt: '2026-03-04T08:00:00Z',
        endedAt: '2026-03-04T09:00:00Z',
        durationMinutes: 60
      })
      .returning()
      .get()
    sessionService.deleteSession(row.id)
    const directory = join(fixture, 'projects', 'C--projects-retained')
    await mkdir(directory, { recursive: true })
    const file = join(directory, 'returned.jsonl')
    const content =
      event('prompt', '2026-03-04T10:00:00Z') + event('reply', '2026-03-04T10:05:00Z', 50)
    await writeFile(file, content)
    expect((await sessionService.scanAndRebuild()).errors).toEqual([
      expect.objectContaining({ sourceFile: file })
    ])
    const review = sessionService.getReconciliationCases()[0]
    expect(review.saved).toEqual([expect.objectContaining({ id: row.id, disposition: 'deleted' })])
    sessionService.keepSavedHistory(file, review.fingerprint!)
    expect((await sessionService.scanAndRebuild()).errors).toBeUndefined()
    sqlite.close()
    openFixture()
    await rm(file)
    expect((await sessionService.rebuildSessionsFromRaw()).errors).toBeUndefined()
    expect(sessionService.getReconciliationCases()).toEqual([])
    const otherPath = join(directory, 'copied.jsonl')
    await writeFile(otherPath, content)
    expect((await sessionService.scanAndRebuild()).errors).toEqual([
      expect.objectContaining({ sourceFile: otherPath })
    ])
    expect(sessionService.getAllSessions()).toEqual([])
    const other = sessionService.getReconciliationCases()[0]
    sessionService.keepSavedHistory(otherPath, other.fingerprint!)
    await appendFile(otherPath, event('new-prompt', '2026-03-04T10:10:00Z'))
    expect((await sessionService.scanAndRebuild()).errors).toEqual([
      expect.objectContaining({ sourceFile: otherPath })
    ])
    expect(db.select().from(sessions).all()).toEqual([row])
    expect(db.select().from(sessionDeletions).all()).toHaveLength(1)
    expect(db.select().from(sessionLegacyRecords).all()).toHaveLength(1)
  })

  it('retains replacement mappings across missing files, restart and later appends', async () => {
    settings.idle_timeout_minutes = '30'
    const directory = join(fixture, 'projects', 'C--projects-retained')
    await mkdir(directory, { recursive: true })
    const file = join(directory, 'replacement.jsonl')
    const content = [0, 5, 20, 25]
      .map((minute) =>
        event(`prompt-${minute}`, new Date(Date.UTC(2026, 2, 4, 10, minute)).toISOString())
      )
      .join('')
    await writeFile(file, content)
    await sessionService.scanAndRebuild()
    const original = sessionService.getAllSessions()[0]
    settings.idle_timeout_minutes = '10'
    await sessionService.rebuildSessionsFromRaw()
    const review = sessionService.getReconciliationCases()[0]
    sessionService.replaceSavedHistory(file, review.fingerprint!)
    const children = sessionService.getAllSessions()
    await rm(file)
    sqlite.close()
    openFixture()
    expect((await sessionService.scanAndRebuild()).errors).toBeUndefined()
    expect(sessionService.getAllSessions()).toEqual(children)
    await writeFile(file, content + event('growth', '2026-03-04T10:30:00Z'))
    expect((await sessionService.scanAndRebuild()).errors).toBeUndefined()
    expect(sessionService.getAllSessions().map((row) => row.id)).toEqual(
      children.map((row) => row.id)
    )
    expect(sessionService.getAllSessions()[1].endedAt).toBe('2026-03-04T10:30:00Z')
    expect(sessionService.getSessionById(original.id)).toBeNull()
    expect(sqlite.pragma('foreign_key_check')).toEqual([])
  })

  it('preserves an explicit split, its audit row and child edits through growth and restart', async () => {
    const directory = join(fixture, 'projects', 'C--projects-retained')
    await mkdir(directory, { recursive: true })
    const file = join(directory, 'fixture-session.jsonl')
    await writeFile(
      file,
      event('prompt', '2026-03-04T10:00:00Z') + event('reply', '2026-03-04T10:10:00Z', 50)
    )
    await sessionService.scanAndRebuild()
    const original = sessionService.getAllSessions()[0]
    const children = sessionService.splitSession(original.id, '2026-03-04T10:04:00Z')
    expect(db.select().from(sessions).all()).toHaveLength(3)
    expect(sessionService.getAllSessions().map((row) => row.id)).toEqual(
      children.map((row) => row.id)
    )
    sessionService.updateSession(children[0].id, {
      description: 'First part',
      durationMinutes: 7,
      billable: false
    })
    await appendFile(
      file,
      event('prompt-2', '2026-03-04T10:12:00Z') + event('reply-2', '2026-03-04T10:15:00Z', 100)
    )
    expect((await sessionService.scanSessions(fixture)).errors).toBeUndefined()
    const grown = sessionService.getAllSessions()
    expect(grown.map((row) => row.id)).toEqual(children.map((row) => row.id))
    expect(grown[0]).toMatchObject({ description: 'First part', durationMinutes: 7, billable: 0 })
    expect(Date.parse(grown[1].endedAt)).toBe(Date.parse('2026-03-04T10:15:00Z'))
    expect(grown[1].durationMinutes).toBe(11)
    expect(grown.reduce((sum, row) => sum + row.outputTokens, 0)).toBe(150)
    expect(db.select().from(sessions).all()[0]).toEqual(original)
    await rm(file)
    sqlite.close()
    openFixture()
    expect((await sessionService.rebuildSessionsFromRaw()).errors).toBeUndefined()
    expect(sessionService.getAllSessions()).toEqual(grown)
  })

  it('keeps explicitly deleted history suppressed after reparse and restart, retaining its audit row', async () => {
    const directory = join(fixture, 'projects', 'C--projects-retained')
    await mkdir(directory, { recursive: true })
    const file = join(directory, 'fixture-session.jsonl')
    const content =
      event('prompt', '2026-03-04T10:00:00Z') + event('reply', '2026-03-04T10:05:00Z', 50)
    await writeFile(file, content)
    await sessionService.scanAndRebuild()
    const original = db.select().from(sessions).get()!
    const usage = db.select().from(sessionModelUsage).all()

    sessionService.deleteSession(original.id)
    expect(sessionService.getAllSessions()).toEqual([])
    expect(db.select().from(sessions).all()).toEqual([original])
    expect(db.select().from(sessionModelUsage).all()).toEqual(usage)

    // Force a full parse, then restart with the source missing.
    db.delete(scanState).run()
    await writeFile(file, content)
    expect((await sessionService.scanAndRebuild()).errors).toBeUndefined()
    expect(sessionService.getAllSessions()).toEqual([])
    await rm(file)
    sqlite.close()
    openFixture()
    expect((await sessionService.rebuildSessionsFromRaw()).errors).toBeUndefined()
    expect(sessionService.getAllSessions()).toEqual([])
    expect(db.select().from(sessions).all()).toEqual([original])
    expect(db.select().from(sessionModelUsage).all()).toEqual(usage)
  })

  it('retains IDs, edits and model totals after append, exclusion, source deletion and restart', async () => {
    const directory = join(fixture, 'projects', 'C--projects-retained')
    await mkdir(directory, { recursive: true })
    const file = join(directory, 'fixture-session.jsonl')
    await writeFile(
      file,
      event('prompt', '2026-03-04T10:00:00Z') + event('reply', '2026-03-04T10:05:00Z', 50)
    )
    await sessionService.scanAndRebuild()
    const original = db.select().from(sessions).get()!
    sessionService.updateSession(original.id, { description: 'Retained note', billable: false })
    await appendFile(
      file,
      event('prompt-2', '2026-03-04T10:10:00Z') + event('reply-2', '2026-03-04T10:12:00Z', 75)
    )
    await sessionService.scanSessions(fixture)
    // A later usage observation corrects an existing event without a new prompt.
    await appendFile(file, event('reply-2', '2026-03-04T10:12:00Z', 100))
    await sessionService.scanSessions(fixture)
    const grown = db.select().from(sessions).all()
    expect(grown).toEqual([
      expect.objectContaining({
        id: original.id,
        description: 'Retained note',
        billable: 0,
        durationMinutes: 12,
        inputTokens: 200,
        outputTokens: 150,
        promptCount: 2
      })
    ])
    const usage = db.select().from(sessionModelUsage).all()
    expect(usage).toEqual([
      expect.objectContaining({
        model: 'fixture-model',
        inputTokens: 200,
        outputTokens: 150,
        cacheReadInputTokens: 100,
        cacheCreationInputTokens: 50
      })
    ])

    setCustomExcludedPaths(['C:\\projects\\retained'])
    await appendFile(file, event('excluded-prompt', '2026-03-04T10:14:00Z'))
    await sessionService.scanAndRebuild()
    expect(db.select().from(rawMessages).all()).toHaveLength(4)
    expect(db.select().from(sessions).all()).toEqual(grown)

    await rm(file)
    sqlite.close()
    openFixture()
    settings.track_claude = 'false'
    await sessionService.scanAndRebuild()
    expect(db.select().from(sessions).all()).toEqual(grown)
    expect(db.select().from(sessionModelUsage).all()).toEqual(usage)
    expect(db.select().from(rawMessages).all()).toHaveLength(4)
  })

  it('does not fabricate activity or overwrite legacy totals when backfill finds no source', async () => {
    const legacy = db
      .insert(sessions)
      .values({
        projectPath: 'C:\\gone',
        sourceFile: join(fixture, 'missing.jsonl'),
        startedAt: '2026-03-04T10:00:00Z',
        endedAt: '2026-03-04T11:00:00Z',
        durationMinutes: 42,
        promptCount: 9,
        inputTokens: 900,
        outputTokens: 300,
        description: 'Old edit'
      })
      .returning()
      .get()
    db.insert(sessionModelUsage)
      .values({ sessionId: legacy.id, model: 'legacy-model', inputTokens: 900, outputTokens: 300 })
      .run()
    const usage = db.select().from(sessionModelUsage).all()
    await sessionService.scanAndRebuild()
    expect(db.select().from(sessions).all()).toEqual([legacy])
    expect(db.select().from(sessionModelUsage).all()).toEqual(usage)
    expect(db.select().from(rawMessages).all()).toEqual([])
  })
})

function captured(sourceFile: string, uuid: string, timestamp: string) {
  db.insert(rawMessages)
    .values({
      sourceFile,
      uuid,
      timestamp,
      type: 'user',
      claudeSessionId: 'fixture-session',
      cwd: 'C:\\projects\\retained'
    })
    .run()
}

it('retains legacy splits and edits across source removal, restart, and returning real logs', async () => {
  const directory = join(fixture, 'projects', 'C--projects-retained')
  await mkdir(directory, { recursive: true })
  const sourceFile = join(directory, 'legacy-split.jsonl')
  const original = db
    .insert(sessions)
    .values({
      projectPath: 'C:\\projects\\retained',
      sourceFile,
      claudeSessionId: 'fixture-session',
      startedAt: '2026-03-04T10:00:00Z',
      endedAt: '2026-03-04T11:00:00Z',
      durationMinutes: 37,
      inputTokens: 101,
      outputTokens: 59,
      promptCount: 11,
      description: 'Saved legacy work'
    })
    .returning()
    .get()
  db.insert(sessionModelUsage)
    .values({
      sessionId: original.id,
      model: 'legacy',
      inputTokens: 101,
      outputTokens: 59,
      cacheCreationInputTokens: 7,
      cacheReadInputTokens: 13
    })
    .run()
  const [first, second] = sessionService.splitSession(original.id, '2026-03-04T10:30:00Z')
  sessionService.updateSession(first.id, { description: 'Edited first part', durationMinutes: 7 })
  const saved = db.select().from(sessions).all()
  const snapshots = db.select().from(sessionLegacyRecords).all()
  const split = db.select().from(sessionSplits).get()
  await sessionService.scanAndRebuild()
  expect(db.select().from(sessions).all()).toEqual(saved)
  sqlite.close()
  openFixture()
  expect(db.select().from(sessions).all()).toEqual(saved)
  expect(db.select().from(sessionLegacyRecords).all()).toEqual(snapshots)
  expect(db.select().from(sessionSplits).get()).toEqual(split)
  expect(db.select().from(sessionDerivations).all()).toEqual([])
  await writeFile(
    sourceFile,
    event('returned-1', '2026-03-04T10:00:00Z') + event('returned-2', '2026-03-04T10:10:00Z', 100)
  )
  const returned = await sessionService.scanAndRebuild()
  expect(returned.errors).toEqual([
    expect.objectContaining({ sourceFile, message: expect.stringContaining('legacy split') })
  ])
  expect(db.select().from(sessions).all()).toEqual(saved)
  sessionService.deleteSession(second.id)
  await sessionService.recheckReconciliation(sourceFile)
  const review = sessionService.getReconciliationCases()[0]
  sessionService.keepSavedHistory(sourceFile, review.fingerprint!)
  // Remove only the fixture log; deletion of its contents is not history deletion.
  await rm(sourceFile)
  sqlite.close()
  openFixture()
  expect((await sessionService.scanAndRebuild()).errors).toBeUndefined()
  expect(sessionService.getAllSessions()).toEqual([
    expect.objectContaining({ id: first.id, description: 'Edited first part', durationMinutes: 7 })
  ])
  expect(db.select().from(sessionLegacyRecords).all()).toEqual(snapshots)
  expect(db.select().from(sessionDeletions).get()?.sessionId).toBe(second.id)
})

describe('Step 0 review regressions', () => {
  it('retains known time overrides when upgrading the previous baseline schema', async () => {
    // Recreate the immediately preceding schema in this disposable database.
    sqlite.exec(
      'DROP TABLE session_splits; DROP TABLE session_revisions; DROP TABLE session_billing_refs'
    )
    sqlite.exec('DROP TABLE session_reconciliation_cases')
    sqlite.exec('DROP TABLE session_reconciliation_resolutions')
    sqlite.exec('DROP TABLE session_time_overrides')
    sqlite.exec('DROP TABLE session_deletions')
    sqlite.exec('DROP TABLE session_legacy_records')
    sqlite.exec('DROP TABLE session_replacements')
    removeClientProjectSyncIds(sqlite)
    sqlite.exec(
      'DROP TABLE activity_sources; DROP TABLE activity_observations; DROP TABLE activity_identities'
    )
    sqlite.prepare('DELETE FROM __drizzle_migrations WHERE created_at > ?').run(1789516800001)
    sqlite.prepare('DELETE FROM __drizzle_migrations WHERE created_at = ?').run(1789516800001)
    const row = db
      .insert(sessions)
      .values({
        projectPath: 'C:\\projects\\retained',
        startedAt: '2026-03-04T10:00:00Z',
        endedAt: '2026-03-04T10:20:00Z',
        durationMinutes: 20
      })
      .returning()
      .get()
    db.insert(sessionDerivations)
      .values({
        sessionId: row.id,
        startedAt: row.startedAt,
        endedAt: '2026-03-04T10:05:00Z',
        durationMinutes: 5
      })
      .run()
    sqlite.close()
    openFixture()
    expect(db.select().from(sessionTimeOverrides).get()).toEqual({
      sessionId: row.id,
      startedAt: 0,
      endedAt: 1,
      durationMinutes: 1
    })
    expect(db.select().from(sessions).get()).toEqual(row)
  })

  it('does not freeze automatic time when an edit submits unchanged time fields', async () => {
    captured('/review/noop.jsonl', 'one', '2026-03-04T10:00:00Z')
    captured('/review/noop.jsonl', 'two', '2026-03-04T10:05:00Z')
    await sessionService.rebuildSessionsFromRaw()
    const row = db.select().from(sessions).get()!
    sessionService.updateSession(row.id, {
      startedAt: row.startedAt,
      endedAt: row.endedAt,
      durationMinutes: row.durationMinutes,
      description: 'A note'
    })
    captured('/review/noop.jsonl', 'three', '2026-03-04T10:10:00Z')
    await sessionService.rebuildSessionsFromRaw()
    expect(db.select().from(sessions).get()).toMatchObject({
      id: row.id,
      durationMinutes: 10,
      description: 'A note'
    })
  })

  it('commits healthy files and their offsets while an unresolved file remains retryable', async () => {
    const directory = join(fixture, 'projects', 'C--projects-retained')
    await mkdir(directory, { recursive: true })
    const bad = join(directory, 'a-legacy.jsonl')
    const good = join(directory, 'b-healthy.jsonl')
    const legacy = db
      .insert(sessions)
      .values({
        sourceFile: bad,
        claudeSessionId: 'fixture-session',
        projectPath: 'C:\\projects\\retained',
        startedAt: '2026-03-04T10:00:00Z',
        endedAt: '2026-03-04T10:05:00Z',
        durationMinutes: 5,
        inputTokens: 1000
      })
      .returning()
      .get()
    // Existing captured data bypasses the one-time legacy backfill.
    captured(bad, 'old', '2026-03-04T10:00:00Z')
    await writeFile(
      bad,
      event('old', '2026-03-04T10:00:00Z') + event('old-reply', '2026-03-04T10:05:00Z', 50)
    )
    await writeFile(
      good,
      event('new', '2026-03-04T11:00:00Z') + event('new-reply', '2026-03-04T11:05:00Z', 50)
    )
    const result = await sessionService.scanSessions(fixture)
    expect(result).toMatchObject({
      newSessions: 1,
      updatedFiles: 1,
      errors: [expect.objectContaining({ sourceFile: bad })]
    })
    const healthy = db
      .select()
      .from(sessions)
      .all()
      .find((s) => s.sourceFile === good)!
    expect(healthy.durationMinutes).toBe(5)
    const checkpoints = db.select().from(scanState).all()
    expect(checkpoints).toEqual([expect.objectContaining({ filePath: good })])
    expect(checkpoints[0].lastFileSize).toBeGreaterThan(0)
    const review = sessionService.getReconciliationCases()
    expect(review).toEqual([
      expect.objectContaining({
        sourceFile: bad,
        saved: [
          expect.objectContaining({ id: legacy.id, inputTokens: 1000, disposition: 'active' })
        ],
        detected: [expect.objectContaining({ inputTokens: 100 })]
      })
    ])
    sqlite.close()
    openFixture()
    expect(sessionService.getReconciliationCases()).toEqual(review)
    const retry = await sessionService.scanSessions(fixture)
    expect(retry).toMatchObject({
      newSessions: 0,
      updatedFiles: 0,
      errors: [expect.objectContaining({ sourceFile: bad })]
    })
    expect(db.select().from(sessions).all()).toEqual([legacy, healthy])
    expect(db.select().from(scanState).all()).toEqual(checkpoints)
    const rebuilt = await sessionService.scanAndRebuild()
    expect(rebuilt.errors).toEqual([expect.objectContaining({ sourceFile: bad })])
    expect(db.select().from(sessions).all()).toEqual([legacy, healthy])
    expect(sessionService.getReconciliationCases()).toHaveLength(1)
    const pending = sessionService.getReconciliationCases()[0]
    sessionService.keepSavedHistory(bad, pending.fingerprint!)
    expect((await sessionService.scanSessions(fixture)).errors).toBeUndefined()
    expect(
      db
        .select()
        .from(scanState)
        .all()
        .some((row) => row.filePath === bad && row.lastFileSize > 0)
    ).toBe(true)
    await rm(bad)
    sqlite.close()
    openFixture()
    expect(sessionService.getReconciliationCases()).toEqual([])
    expect((await sessionService.rebuildSessionsFromRaw()).errors).toBeUndefined()
    expect(db.select().from(sessions).all()).toEqual([legacy, healthy])
    await writeFile(
      bad,
      event('old', '2026-03-04T10:00:00Z') +
        event('old-reply', '2026-03-04T10:05:00Z', 50) +
        event('new-tail', '2026-03-04T10:10:00Z')
    )
    expect((await sessionService.scanSessions(fixture)).errors).toHaveLength(1)
    expect(db.select().from(sessions).all()).toEqual([legacy, healthy])
  })

  it('clears only successfully reconciled reviews and reopens them when boundaries change again', async () => {
    const file = '/review/policy.jsonl'
    captured(file, 'one', '2026-03-04T10:00:00Z')
    captured(file, 'two', '2026-03-04T10:10:00Z')
    await sessionService.rebuildSessionsFromRaw()
    const original = sessionService.getAllSessions()[0]
    sessionService.updateSession(original.id, { description: 'Keep this note' })
    settings.idle_timeout_minutes = '5'
    await sessionService.rebuildSessionsFromRaw()
    expect(sessionService.getReconciliationCases()).toEqual([
      expect.objectContaining({ sourceFile: file, detected: expect.any(Array) })
    ])
    expect(sessionService.getReconciliationCases()[0].detected).toHaveLength(2)
    settings.track_claude = 'false'
    await sessionService.scanSessions(fixture)
    expect(sessionService.getReconciliationCases()).toHaveLength(1)
    settings.idle_timeout_minutes = '15'
    expect((await sessionService.recheckReconciliation(file)).errors).toBeUndefined()
    expect(sessionService.getReconciliationCases()).toEqual([])
    expect(sessionService.getAllSessions()[0]).toMatchObject({
      id: original.id,
      description: 'Keep this note'
    })
    settings.idle_timeout_minutes = '5'
    await sessionService.rebuildSessionsFromRaw()
    expect(sessionService.getReconciliationCases()).toHaveLength(1)
  })

  it('preserves explicit time edits after automatic measurements catch up and grow again', async () => {
    captured('/review/edited.jsonl', 'one', '2026-03-04T10:00:00Z')
    captured('/review/edited.jsonl', 'two', '2026-03-04T10:05:00Z')
    await sessionService.rebuildSessionsFromRaw()
    const original = db.select().from(sessions).get()!
    sessionService.updateSession(original.id, {
      endedAt: '2026-03-04T10:20:00Z',
      durationMinutes: 20
    })
    captured('/review/edited.jsonl', 'three', '2026-03-04T10:15:00Z')
    captured('/review/edited.jsonl', 'four', '2026-03-04T10:20:00Z')
    await sessionService.rebuildSessionsFromRaw()
    expect(db.select().from(sessions).get()?.durationMinutes).toBe(20)
    sqlite.close()
    openFixture()
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
    await writeFile(
      main,
      event('p', '2026-03-04T10:00:00Z') + event('a', '2026-03-04T10:05:00Z', 50)
    )
    const subEvent = JSON.parse(event('sub-a', '2026-03-04T10:03:00Z', 75))
    subEvent.message.model = 'subagent-model'
    await writeFile(sub, JSON.stringify(subEvent) + '\n')
    await sessionService.scanAndRebuild()
    const original = db.select().from(sessions).get()!
    expect(original.inputTokens).toBe(200)
    const usage = db.select().from(sessionModelUsage).all()
    expect(usage.map((u) => u.model).sort()).toEqual(['fixture-model', 'subagent-model'])
    await rm(sub)
    await appendFile(main, event('p2', '2026-03-04T10:10:00Z'))
    await sessionService.scanSessions(fixture)
    expect(
      db
        .select()
        .from(rawMessages)
        .all()
        .filter((r) => r.isSubagent === 1)
    ).toHaveLength(1)
    expect(db.select().from(sessions).get()?.inputTokens).toBe(200)
    expect(db.select().from(sessionModelUsage).all()).toEqual(usage)
  })

  it('allows unrelated captured history to reconcile despite one legacy mismatch', async () => {
    db.insert(sessions)
      .values({
        sourceFile: '/review/a-legacy.jsonl',
        claudeSessionId: 'fixture-session',
        projectPath: 'C:\\projects\\retained',
        startedAt: '2026-03-04T10:00:00Z',
        endedAt: '2026-03-04T10:05:00Z',
        durationMinutes: 5,
        inputTokens: 1000
      })
      .run()
    captured('/review/a-legacy.jsonl', 'old', '2026-03-04T10:00:00Z')
    captured('/review/b-healthy.jsonl', 'new', '2026-03-04T11:00:00Z')
    const result = await sessionService.rebuildSessionsFromRaw()
    expect(result.errors).toEqual([
      expect.objectContaining({ sourceFile: '/review/a-legacy.jsonl' })
    ])
    expect(result.newSessions).toBe(1)
    expect(
      db
        .select()
        .from(sessions)
        .all()
        .some((row) => row.sourceFile === '/review/b-healthy.jsonl')
    ).toBe(true)
  })
})
