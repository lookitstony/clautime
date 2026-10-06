// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { removeClientProjectSyncIds } from '../db/migration-test-helpers'
import {
  activityIdentities,
  activityObservations,
  activitySources
} from '../db/schema/activity-evidence'
import { activityObservers, sourceMachines } from '../db/schema/activity-observers'
import { folderSyncSettings, syncChanges } from '../db/schema/folder-sync'
import { rawMessages } from '../db/schema/raw-messages'
import { scanState } from '../db/schema/scan-state'
import { parseSessionFile } from '../parsers/session-parser'
import { parseCodexSessionFile } from '../parsers/codex-parser'
import { parseGeminiSessionFile } from '../parsers/gemini-parser'
import { OpencodeIdentityCapture } from '../parsers/opencode-activity-identity'
import { parseOpencodeSessionFile } from '../parsers/opencode-parser'
import type { ParsedSessionData } from '../parsers/types'
import { storeActivityEvidence } from './activity-evidence'
import { readCodexCheckpointDeltas } from './codex-checkpoint-deltas'

vi.mock('electron-log/main.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
}))
const deviceA = '9b95ec41-b3b6-4cbb-b1b6-e7ce607ef222'
const deviceB = '7c8f7eab-af58-4cbb-9e74-d1e47f80d600'
let deviceId = deviceA
vi.mock('./device-context', () => ({
  getLocalDeviceSession: () => ({ deviceId, machineName: 'Same friendly label' })
}))
let directory: string
let sqlite: Database.Database
let db: BetterSQLite3Database
const timestamp = '2026-07-19T18:07:00.000Z'
const migrationsFolder = join(__dirname, '../db/migrations')
function open(): void {
  sqlite = new Database(join(directory, 'history.db'))
  sqlite.pragma('foreign_keys = ON')
  db = drizzle(sqlite)
  migrate(db, { migrationsFolder })
}
beforeEach(async () => {
  deviceId = deviceA
  directory = await mkdtemp(join(tmpdir(), 'clautime-evidence-'))
  open()
})
afterEach(async () => {
  sqlite.close()
  await rm(directory, { recursive: true, force: true })
})
function store(parsed: ParsedSessionData, connection = db): void {
  connection.transaction((tx) => storeActivityEvidence(tx, parsed, timestamp))
}
async function claude(name = 'original.jsonl', usage = 100) {
  const path = join(directory, name)
  await writeFile(
    path,
    JSON.stringify({
      type: 'assistant',
      sessionId: 'conversation-a',
      uuid: 'message-1',
      parentUuid: null,
      timestamp,
      cwd: 'C:/private-project',
      message: {
        model: 'fixture-model',
        content: [{ type: 'text', text: 'TRANSCRIPT_SENTINEL' }],
        usage: { input_tokens: usage, output_tokens: 10 }
      }
    }) + '\n'
  )
  return (await parseSessionFile(path))!
}

it('deduplicates copied observations while recording every physical source', async () => {
  const first = await claude()
  const copy = await claude('copy.jsonl')
  store(first)
  store(copy)
  store(first)
  expect(db.select().from(activityIdentities).all()).toHaveLength(1)
  expect(db.select().from(activityObservations).all()).toHaveLength(1)
  expect(db.select().from(activitySources).all()).toHaveLength(2)
  const observation = db.select().from(activityObservations).get()!
  expect({
    id: observation.id,
    version: observation.version,
    kind: observation.kind,
    payloadJson: observation.payloadJson
  }).toMatchInlineSnapshot(`
    {
      "id": "observation:v1:722843eb596a681180d4bdadea0409a77698110856d0cf54e4c4b4fdf1a052a3",
      "kind": "message",
      "payloadJson": "{"hasToolUse":false,"isToolResult":false,"model":"fixture-model","parentEventId":null,"timestamp":"2026-07-19T18:07:00.000Z","toolNames":[],"type":"assistant","usage":{"cacheCreationInputTokens":0,"cacheReadInputTokens":0,"inputTokens":100,"outputTokens":10}}",
      "version": 1,
    }
  `)
  const stored = JSON.stringify(db.select().from(activityObservations).all())
  expect(stored).not.toContain('TRANSCRIPT_SENTINEL')
  expect(stored).not.toContain('private-project')
  expect(stored).not.toContain(directory.replace(/\\/g, '\\\\'))
})

it('retains usage corrections and parent alternatives without choosing a winner', async () => {
  store(await claude())
  const corrected = await claude('original.jsonl', 200)
  store(corrected)
  corrected.messages[0].activityIdentity!.parentEventId = 'different-parent'
  store(corrected)
  const observations = db.select().from(activityObservations).all()
  expect(db.select().from(activityIdentities).all()).toHaveLength(1)
  expect(observations).toHaveLength(3)
  expect(observations.map((row) => JSON.parse(row.payloadJson).usage.inputTokens).sort()).toEqual([
    100, 200, 200
  ])
})

it('converges on the same identities and observations in independently populated databases', async () => {
  const first = await claude()
  const corrected = await claude('copy.jsonl', 200)
  const otherSqlite = new Database(':memory:')
  try {
    const otherDb = drizzle(otherSqlite)
    migrate(otherDb, { migrationsFolder })
    store(first)
    store(corrected)
    deviceId = deviceB
    store(corrected, otherDb)
    store(first, otherDb)
    expect(otherDb.select().from(activityIdentities).all()).toEqual(
      db.select().from(activityIdentities).all()
    )
    expect(
      otherDb.select().from(activityObservations).orderBy(activityObservations.id).all()
    ).toEqual(db.select().from(activityObservations).orderBy(activityObservations.id).all())
    expect(
      db
        .select()
        .from(activityObservers)
        .all()
        .map((row) => row.deviceId)
    ).toEqual([deviceA, deviceA])
    expect(
      otherDb
        .select()
        .from(activityObservers)
        .all()
        .map((row) => row.deviceId)
    ).toEqual([deviceB, deviceB])
  } finally {
    otherSqlite.close()
  }
})

it('retains evidence after source removal and database restart', async () => {
  const parsed = await claude()
  store(parsed)
  const saved = db.select().from(activityObservations).all()
  await rm(parsed.sourceFile)
  sqlite.close()
  open()
  expect(db.select().from(activityObservations).all()).toEqual(saved)
  expect(db.select().from(activitySources).all()).toHaveLength(1)
})

it('keeps subagent source attribution separate from portable observation hashes', async () => {
  const parsed = await claude()
  store(parsed)
  const agentMessage = { ...parsed.messages[0], sourceFile: join(directory, 'agent.jsonl') }
  store({ ...parsed, messages: [], subagentMessages: [agentMessage] })
  expect(db.select().from(activityObservations).all()).toHaveLength(1)
  expect(db.select().from(activitySources).all()).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ sourceFile: agentMessage.sourceFile, isSubagent: 1 }),
      expect.objectContaining({ sourceFile: parsed.sourceFile, isSubagent: 0 })
    ])
  )
})

it('deduplicates copied Claude progress and retains corrected timing and subagent provenance', async () => {
  const raw = {
    type: 'progress',
    sessionId: 'progress-session',
    uuid: 'progress-a',
    parentUuid: 'message-a',
    timestamp,
    data: { type: 'agent_progress', message: { content: 'PRIVATE_TRANSCRIPT' } }
  }
  const original = join(directory, 'progress-session.jsonl')
  const copy = join(directory, 'copy.jsonl')
  const subdir = join(directory, 'progress-session', 'subagents')
  await mkdir(subdir, { recursive: true })
  const agent = join(subdir, 'renamed-agent.jsonl')
  for (const path of [original, copy, agent]) await writeFile(path, JSON.stringify(raw) + '\n')
  store((await parseSessionFile(original))!)
  store((await parseSessionFile(copy))!)
  expect(db.select().from(activityIdentities).all()).toHaveLength(1)
  const rows = db.select().from(activityObservations).all()
  expect(rows).toHaveLength(1)
  expect(JSON.parse(rows[0].payloadJson)).toMatchObject({
    kind: 'progress',
    progressType: 'agent_progress',
    timestamp
  })
  expect(JSON.stringify(rows)).not.toContain('PRIVATE_')
  expect(db.select().from(activitySources).all()).toHaveLength(3)
  expect(
    db
      .select()
      .from(activitySources)
      .all()
      .find((row) => row.isSubagent === 1)?.sourceFile
  ).toBe(agent)
  await writeFile(copy, JSON.stringify({ ...raw, timestamp: '2026-07-19T18:08:00Z' }) + '\n')
  store((await parseSessionFile(copy))!)
  expect(db.select().from(activityIdentities).all()).toHaveLength(1)
  const observations = db.select().from(activityObservations).orderBy(activityObservations.id).all()
  expect(observations).toHaveLength(2)
  for (const path of [original, copy, agent]) await rm(path)
  sqlite.close()
  open()
  expect(db.select().from(activityObservations).orderBy(activityObservations.id).all()).toEqual(
    observations
  )
})

it('persists non-message Codex activities and corrected checkpoints with their source links', async () => {
  const path = join(directory, 'codex.jsonl')
  const checkpoint = (input: number) => ({
    timestamp,
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: { total_token_usage: { input_tokens: input, cached_input_tokens: 2, output_tokens: 3 } }
    }
  })
  await writeFile(
    path,
    [
      // Deliberately no timestamp: canonical header identity must not use filename fallback.
      { type: 'session_meta', payload: { id: 'thread-a' } },
      checkpoint(10),
      checkpoint(20),
      checkpoint(20),
      {
        timestamp,
        type: 'response_item',
        payload: { type: 'reasoning', summary: [{ text: 'PRIVATE_REASONING' }] }
      },
      {
        timestamp,
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'PRIVATE_PROMPT' }]
        }
      }
    ]
      .map((record) => JSON.stringify(record))
      .join('\n')
  )
  const parsed = (await parseCodexSessionFile(path))!
  expect(parsed.codexActivityEvidence!.status).toBe('captured')
  store(parsed)
  store(parsed)
  const events = db.select().from(activityIdentities).all()
  expect(events).toHaveLength(3)
  expect(events.every((event) => event.conversationId === 'thread-a')).toBe(true)
  const observations = db.select().from(activityObservations).all()
  expect(observations.filter((row) => row.kind === 'checkpoint')).toHaveLength(2)
  expect(observations.filter((row) => row.kind === 'activity')).toHaveLength(1)
  expect(JSON.stringify(observations)).not.toContain('PRIVATE_')
  expect(
    observations
      .filter((row) => row.kind === 'checkpoint')
      .map((row) => JSON.parse(row.payloadJson).totals.input_tokens)
      .sort()
  ).toEqual([10, 20])
})

it('persists Codex progress as anchored leaves with type and time only, deduplicated across copies', async () => {
  const event = (at: string, payload: Record<string, unknown>) => ({
    timestamp: at,
    type: 'event_msg',
    payload
  })
  const records = [
    { timestamp, type: 'session_meta', payload: { id: 'thread-a' } },
    {
      timestamp,
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'PRIVATE_PROMPT' }]
      }
    },
    event('2026-07-19T18:07:05.000Z', {
      type: 'exec_command_output_delta',
      chunk: 'PRIVATE_OUTPUT',
      call_id: 'PRIVATE_CALL'
    }),
    event('2026-07-19T18:07:06.000Z', { type: 'token_count', info: null }),
    event('2026-07-19T18:07:07.000Z', {
      type: 'token_count',
      info: { total_token_usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 1 } }
    })
  ]
  const parsed: ParsedSessionData[] = []
  for (const name of ['original.jsonl', 'copy.jsonl']) {
    const path = join(directory, name)
    await writeFile(path, records.map((record) => JSON.stringify(record)).join('\n') + '\n')
    parsed.push((await parseCodexSessionFile(path))!)
  }
  store(parsed[0])
  deviceId = deviceB
  store(parsed[1])
  store(parsed[0])
  const prompt = parsed[0].messages[0].activityIdentity!.eventId
  const identities = db.select().from(activityIdentities).all()
  expect(identities.map((identity) => identity.basis).sort()).toEqual([
    'checkpoint',
    'fingerprint',
    'progress',
    'progress'
  ])
  const leaves = new Set(
    identities
      .filter((identity) => identity.basis === 'progress')
      .map((identity) => identity.eventId)
  )
  const progress = db
    .select()
    .from(activityObservations)
    .all()
    .filter((row) => leaves.has(row.eventId))
  expect(
    progress
      .map((row) => [row.kind, JSON.parse(row.payloadJson)])
      .sort((a, b) => (a[1].timestamp < b[1].timestamp ? -1 : 1))
  ).toEqual([
    [
      'activity',
      {
        kind: 'progress',
        progressType: 'exec_command_output_delta',
        timestamp: '2026-07-19T18:07:05.000Z',
        parentEventId: prompt
      }
    ],
    [
      'activity',
      {
        kind: 'progress',
        progressType: 'token_count',
        timestamp: '2026-07-19T18:07:06.000Z',
        parentEventId: prompt
      }
    ]
  ])
  // One observation each, seen by both computers and linked to both physical copies.
  const ids = new Set(progress.map((row) => row.id))
  const linked = (rows: Array<{ observationId: string }>) =>
    rows.filter((row) => ids.has(row.observationId))
  expect(linked(db.select().from(activityObservers).all())).toHaveLength(4)
  expect(linked(db.select().from(activitySources).all())).toHaveLength(4)
  expect(JSON.stringify(db.select().from(activityObservations).all())).not.toContain('PRIVATE_')
})

it.each([true, false])(
  'derives matching Codex branch results in opposite database orders (shared checkpoint: %s)',
  async (sharedCheckpoint) => {
    const item = (text: string, at: string) => ({
      timestamp: at,
      type: 'response_item',
      payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] }
    })
    const checkpoint = (input: number, at: string) => ({
      timestamp: at,
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: {
          total_token_usage: { input_tokens: input, cached_input_tokens: 10, output_tokens: 8 }
        }
      }
    })
    const prefix = [
      { timestamp, type: 'session_meta', payload: { id: 'thread-a' } },
      { timestamp, type: 'turn_context', payload: { model: 'fixture-model' } },
      item('Shared prompt', timestamp),
      ...(sharedCheckpoint ? [checkpoint(100, '2026-07-19T18:07:01Z')] : [])
    ]
    const parsed: ParsedSessionData[] = []
    for (const [name, input] of [
      ['left', 130],
      ['right', 170]
    ] as const) {
      const path = join(directory, `${name}.jsonl`)
      await writeFile(
        path,
        [...prefix, item(name, '2026-07-19T18:08:00Z'), checkpoint(input, '2026-07-19T18:08:01Z')]
          .map((row) => JSON.stringify(row))
          .join('\n') + '\n'
      )
      parsed.push((await parseCodexSessionFile(path))!)
    }
    const otherSqlite = new Database(':memory:')
    try {
      const otherDb = drizzle(otherSqlite)
      migrate(otherDb, { migrationsFolder })
      for (const source of parsed) store(source)
      store({ ...parsed[0], sourceFile: 'moved-copy.jsonl' })
      for (const source of [...parsed].reverse()) store(source, otherDb)
      const deltas = readCodexCheckpointDeltas(db)
      expect(readCodexCheckpointDeltas(otherDb)).toEqual(deltas)
      if (!sharedCheckpoint) {
        expect(deltas).toHaveLength(2)
        for (const delta of deltas)
          expect(delta).toMatchObject({ status: 'unresolved', reason: 'ambiguous-root-baseline' })
        return
      }
      expect(deltas).toHaveLength(3)
      expect(
        deltas
          .map((row) => row.status === 'resolved' && row.delta.input_tokens)
          .sort((a, b) => Number(a) - Number(b))
      ).toEqual([30, 70, 100])
      expect(
        deltas
          .filter((row) => row.status === 'resolved')
          .reduce((sum, row) => sum + row.delta.input_tokens, 0)
      ).toBe(200)
    } finally {
      otherSqlite.close()
    }
  }
)

it('persists Gemini progress identities without duplicating normalized message observations', async () => {
  const path = join(directory, 'gemini.json')
  await writeFile(
    path,
    JSON.stringify({
      sessionId: 'gemini-a',
      messages: [
        { id: 'user-1', type: 'user', timestamp, content: 'PRIVATE_PROMPT' },
        { id: 'info-1', type: 'info', timestamp, content: 'PRIVATE_INFO' }
      ]
    })
  )
  store((await parseGeminiSessionFile(path))!)
  expect(db.select().from(activityIdentities).all()).toHaveLength(2)
  const rows = db.select().from(activityObservations).all()
  expect(rows.map((row) => row.kind).sort()).toEqual(['activity', 'message'])
  expect(JSON.stringify(rows)).not.toContain('PRIVATE_')
})

it('persists OpenCode part ownership and parent conversation evidence', async () => {
  const parsed = await claude()
  const capture = new OpencodeIdentityCapture('agent-a', 'parent-a')
  const identity = capture.message({
    id: 'msg_a',
    sessionID: 'agent-a',
    role: 'user',
    time: { created: Date.parse(timestamp) }
  })!
  capture.part(
    { id: 'prt_a', sessionID: 'agent-a', messageID: 'msg_a', type: 'compaction' },
    'msg_a'
  )
  store({
    ...parsed,
    tool: 'opencode',
    messages: [{ ...parsed.messages[0], type: 'user', activityIdentity: identity }],
    opencodeActivityEvidence: capture.finish()
  })
  expect(db.select().from(activityIdentities).all()).toHaveLength(2)
  const rows = db.select().from(activityObservations).all()
  expect(rows.every((row) => JSON.parse(row.payloadJson).parentConversationId === 'parent-a')).toBe(
    true
  )
  expect(JSON.parse(rows.find((row) => row.kind === 'activity')!.payloadJson).parentEventId).toBe(
    identity.eventId
  )
})

async function opencode(name: string, completed = 2000) {
  const root = join(directory, name)
  const sessionDir = join(root, 'session', 'project')
  const messageDir = join(root, 'message', 'ses_a')
  const partDir = join(root, 'part', 'msg_a')
  for (const path of [sessionDir, messageDir, partDir]) await mkdir(path, { recursive: true })
  const source = join(sessionDir, 'ses_a.json')
  const start = Date.parse(timestamp)
  await writeFile(source, JSON.stringify({ id: 'ses_a', directory: root }))
  await writeFile(
    join(messageDir, 'msg_a.json'),
    JSON.stringify({
      id: 'msg_a',
      sessionID: 'ses_a',
      role: 'assistant',
      time: { created: start, completed: start + completed },
      modelID: 'fixture-model',
      tokens: { input: 100, output: 10 }
    })
  )
  await writeFile(
    join(partDir, 'prt_a.json'),
    JSON.stringify({
      id: 'prt_a',
      sessionID: 'ses_a',
      messageID: 'msg_a',
      type: 'tool',
      tool: 'read',
      state: {
        status: 'completed',
        input: { path: 'PRIVATE_PATH' },
        output: 'PRIVATE_OUTPUT',
        time: { start: start + 1000, end: start + completed, compacted: start + 9000 }
      }
    })
  )
  return (await parseOpencodeSessionFile(source))!
}

it('retains OpenCode tool and completion timing across copies and source removal', async () => {
  const first = await opencode('original')
  store(first)
  store(await opencode('copy'))
  store(first)
  const rows = db.select().from(activityObservations).orderBy(activityObservations.id).all()
  expect(rows).toHaveLength(2)
  expect(db.select().from(activitySources).all()).toHaveLength(4)
  const message = JSON.parse(rows.find((row) => row.kind === 'message')!.payloadJson)
  const part = JSON.parse(rows.find((row) => row.kind === 'activity')!.payloadJson)
  expect(message.timing).toEqual({ completedAt: '2026-07-19T18:07:02.000Z' })
  expect(part.timing).toEqual({
    startedAt: '2026-07-19T18:07:01.000Z',
    endedAt: '2026-07-19T18:07:02.000Z'
  })
  expect([part.timing.startedAt, part.timing.endedAt, message.timing.completedAt].sort()).toEqual(
    first.progressTimestamps
  )
  expect(JSON.stringify(rows)).not.toContain('PRIVATE_')
  expect(JSON.stringify(rows)).not.toContain('18:07:09.000Z')
  await rm(first.sourceFile)
  sqlite.close()
  open()
  expect(db.select().from(activityObservations).orderBy(activityObservations.id).all()).toEqual(
    rows
  )
})

it('retains timing corrections under the same OpenCode identities regardless of arrival order', async () => {
  const first = await opencode('original')
  const corrected = await opencode('corrected', 3000)
  expect(corrected.totalTokenUsage).toEqual(first.totalTokenUsage)
  const otherSqlite = new Database(':memory:')
  try {
    const other = drizzle(otherSqlite)
    migrate(other, { migrationsFolder })
    store(first)
    store(corrected)
    store(corrected, other)
    store(first, other)
    expect(db.select().from(activityIdentities).all()).toHaveLength(2)
    const rows = db.select().from(activityObservations).orderBy(activityObservations.id).all()
    expect(rows).toHaveLength(4)
    expect(
      other.select().from(activityObservations).orderBy(activityObservations.id).all()
    ).toEqual(rows)
    expect(
      rows
        .filter((row) => row.kind === 'message')
        .map((row) => JSON.parse(row.payloadJson).timing.completedAt)
        .sort()
    ).toEqual(['2026-07-19T18:07:02.000Z', '2026-07-19T18:07:03.000Z'])
  } finally {
    otherSqlite.close()
  }
})

it('keeps each repeated native message observation paired with its own completion time', async () => {
  const parsed = await opencode('repeated')
  const messageDir = join(directory, 'repeated', 'message', 'ses_a')
  await writeFile(
    join(messageDir, 'msg_copy.json'),
    JSON.stringify({
      id: 'msg_a',
      sessionID: 'ses_a',
      role: 'assistant',
      time: { created: Date.parse(timestamp), completed: Date.parse(timestamp) + 3000 },
      modelID: 'fixture-model',
      tokens: { input: 200, output: 10 }
    })
  )
  store((await parseOpencodeSessionFile(parsed.sourceFile))!)
  const rows = db
    .select()
    .from(activityObservations)
    .all()
    .filter((row) => row.kind === 'message')
  expect(
    rows
      .map((row) => {
        const payload = JSON.parse(row.payloadJson)
        return [payload.usage.inputTokens, payload.timing.completedAt]
      })
      .sort()
  ).toEqual([
    [100, '2026-07-19T18:07:02.000Z'],
    [200, '2026-07-19T18:07:03.000Z']
  ])
})

it('does not invent evidence from legacy metadata or remove earlier evidence on an unavailable parse', async () => {
  const parsed = await claude()
  const legacy = { ...parsed, messages: [{ ...parsed.messages[0], activityIdentity: null }] }
  store(legacy)
  expect(db.select().from(activityIdentities).all()).toHaveLength(0)
  store(parsed)
  const observations = db.select().from(activityObservations).all()
  store(legacy)
  expect(db.select().from(activityObservations).all()).toEqual(observations)
})

it('rolls observations and source links back together with the caller transaction', async () => {
  const parsed = await claude()
  expect(() =>
    db.transaction((tx) => {
      storeActivityEvidence(tx, parsed, timestamp)
      throw new Error('fixture raw-message failure')
    })
  ).toThrow('fixture raw-message failure')
  expect(db.select().from(activityIdentities).all()).toHaveLength(0)
  expect(db.select().from(activityObservations).all()).toHaveLength(0)
  expect(db.select().from(activitySources).all()).toHaveLength(0)
  expect(db.select().from(activityObservers).all()).toHaveLength(0)
  expect(db.select().from(sourceMachines).all()).toHaveLength(0)
})

it('upgrades existing history without fabricating identities and schedules a full source re-read', () => {
  removeClientProjectSyncIds(sqlite)
  sqlite.exec(
    'DROP TABLE activity_sources; DROP TABLE activity_observations; DROP TABLE activity_identities'
  )
  sqlite.prepare('DELETE FROM __drizzle_migrations WHERE created_at = ?').run(1789603200007)
  db.insert(rawMessages).values({ sourceFile: 'missing.jsonl', type: 'user', timestamp }).run()
  db.insert(scanState)
    .values({
      filePath: 'missing.jsonl',
      lastModifiedAt: timestamp,
      lastScannedAt: timestamp,
      lastFileSize: 123
    })
    .run()
  const legacy = db.select().from(rawMessages).all()
  migrate(db, { migrationsFolder })
  expect(db.select().from(rawMessages).all()).toEqual(legacy)
  expect(db.select().from(activityIdentities).all()).toHaveLength(0)
  expect(db.select().from(scanState).get()).toMatchObject({ lastFileSize: 0, lastScannedAt: '' })
  expect(sqlite.prepare('PRAGMA foreign_key_check').all()).toEqual([])
})

it('records two observing computers for one copied activity without changing its identity or usage', async () => {
  const first = await claude()
  store(first)
  const facts = db.select().from(activityObservations).all()
  deviceId = deviceB
  store(await claude('copy.jsonl'))
  store(first)
  expect(db.select().from(activityIdentities).all()).toHaveLength(1)
  expect(db.select().from(activityObservations).all()).toEqual(facts)
  expect(db.select().from(activityObservers).orderBy(activityObservers.deviceId).all()).toEqual(
    [deviceA, deviceB].sort().map((deviceId) => ({
      observationId: facts[0].id,
      deviceId,
      basis: 'observed'
    }))
  )
  expect(db.select().from(sourceMachines).all()).toHaveLength(2)
  for (const source of db.select().from(activitySources).all()) await rm(source.sourceFile)
  sqlite.close()
  open()
  expect(db.select().from(activityObservers).all()).toHaveLength(2)
  expect(db.select().from(activityObservations).all()).toEqual(facts)
})

it('attributes corrections only to computers that observed that version', async () => {
  store(await claude())
  const original = db.select().from(activityObservations).get()!
  deviceId = deviceB
  store(await claude('corrected.jsonl', 200))
  const observations = db.select().from(activityObservations).all()
  expect(observations).toHaveLength(2)
  expect(db.select().from(activityObservers).all()).toEqual(
    expect.arrayContaining([
      { observationId: original.id, deviceId: deviceA, basis: 'observed' },
      {
        observationId: observations.find((row) => row.id !== original.id)!.id,
        deviceId: deviceB,
        basis: 'observed'
      }
    ])
  )
  expect(db.select().from(activityObservers).all()).toHaveLength(2)
})

it('journals captured facts even while folder transfer is disabled, in the capture transaction', async () => {
  db.insert(folderSyncSettings)
    .values({
      slot: 1,
      workspaceId: '23d1e4d1-7f6b-4935-b18c-367ae5ff5fb9',
      folderPath: directory,
      enabled: 0
    })
    .run()
  const parsed = await claude()
  expect(() =>
    db.transaction((tx) => {
      storeActivityEvidence(tx, parsed, timestamp)
      expect(tx.select().from(syncChanges).all()).toHaveLength(4)
      throw new Error('fixture rollback')
    })
  ).toThrow('fixture rollback')
  expect(db.select().from(syncChanges).all()).toHaveLength(0)
  expect(db.select().from(activityObservations).all()).toHaveLength(0)
  store(parsed)
  store(parsed)
  const outgoing = db.select().from(syncChanges).all()
  expect(outgoing).toHaveLength(4)
  expect(outgoing.every((change) => change.origin === 'local')).toBe(true)
  expect(JSON.stringify(outgoing)).not.toMatch(/TRANSCRIPT_SENTINEL|private-project/)
})
