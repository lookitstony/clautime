// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { activityObservations } from '../db/schema/activity-evidence'
import { parseOpencodeSessionFile } from '../parsers/opencode-parser'
import type { ParsedSessionData } from '../parsers/types'
import { storeActivityEvidence } from './activity-evidence'
import { readCanonicalActivity } from './canonical-activity'
import { calculateCanonicalIntervals, readCanonicalIntervalSnapshot } from './canonical-intervals'
import { detectSessionsWithPolicy } from './session-detector'
import { adoptInitialWorkspacePolicy, previewLedgerWorkspacePolicy } from './workspace-policy'

vi.mock('electron-log/main.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
}))
let deviceId = '9b95ec41-b3b6-4cbb-b1b6-e7ce607ef222'
vi.mock('./device-context', () => ({
  getLocalDeviceSession: () => ({ deviceId, machineName: 'Fixture machine' })
}))

type Db = ReturnType<typeof drizzle>
type Json = Record<string, unknown>
const migrationsFolder = join(__dirname, '../db/migrations')
const policy = {
  version: 1,
  normalizationVersion: 2,
  detectorVersion: 1,
  idleTimeoutMinutes: 15,
  reportingTimeZone: 'UTC'
}
const opened: Database.Database[] = []
let db: Db
let sqlite: Database.Database
let directory: string

function database() {
  const connection = new Database(':memory:')
  connection.pragma('foreign_keys = ON')
  opened.push(connection)
  const target = drizzle(connection)
  migrate(target, { migrationsFolder })
  return { connection, target }
}
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'clautime-opencode-canonical-'))
  const created = database()
  sqlite = created.connection
  db = created.target
  deviceId = '9b95ec41-b3b6-4cbb-b1b6-e7ce607ef222'
})
afterEach(() => {
  for (const connection of opened.splice(0)) connection.close()
  const target = resolve(directory)
  if (
    !target.startsWith(resolve(tmpdir()) + sep) ||
    !target.includes('clautime-opencode-canonical-')
  )
    throw new Error('Unexpected fixture directory')
  rmSync(target, { recursive: true, force: true })
})

const base = Date.parse('2026-09-26T03:00:00.000Z')
const at = (minute: number) => base + Math.round(minute * 60_000)
const iso = (minute: number) => new Date(at(minute)).toISOString()

/** One OpenCode document store: session metadata, one file per message and per part. */
class Store {
  constructor(readonly root: string) {}
  private write(path: string, value: unknown) {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, JSON.stringify(value))
  }
  session(id: string, extra: Json = {}) {
    const path = join(this.root, 'session', 'project', `${id}.json`)
    this.write(path, {
      id,
      projectID: 'project',
      directory: 'C:/private-project',
      title: 'PRIVATE_TRANSCRIPT',
      time: { created: at(0), updated: at(0) },
      ...extra
    })
    return path
  }
  prompt(session: string, id: string, minute: number) {
    this.write(join(this.root, 'message', session, `${id}.json`), {
      id,
      sessionID: session,
      role: 'user',
      time: { created: at(minute) }
    })
    this.part(session, id, `prt_${id}_text`, { type: 'text', text: 'PRIVATE_TRANSCRIPT' })
  }
  reply(
    session: string,
    id: string,
    parentID: string | undefined,
    minute: number,
    options: { completed?: number; tokens?: Json; model?: string } = {}
  ) {
    this.write(join(this.root, 'message', session, `${id}.json`), {
      id,
      sessionID: session,
      role: 'assistant',
      ...(parentID ? { parentID } : {}),
      modelID: options.model ?? 'fixture-model',
      providerID: 'fixture-provider',
      mode: 'build',
      path: { cwd: 'C:/private-project', root: 'C:/private-project' },
      cost: 0,
      time: {
        created: at(minute),
        ...(options.completed !== undefined ? { completed: at(options.completed) } : {})
      },
      ...(options.tokens ? { tokens: options.tokens } : {})
    })
    this.part(session, id, `prt_${id}_step`, { type: 'step-start' })
  }
  tool(session: string, message: string, id: string, start: number, end?: number) {
    this.part(session, message, id, {
      type: 'tool',
      tool: 'read',
      callID: `call_${id}`,
      state: {
        status: end === undefined ? 'running' : 'completed',
        input: { filePath: 'C:/private-project/secret.ts' },
        ...(end === undefined ? {} : { output: 'PRIVATE_TRANSCRIPT' }),
        time: { start: at(start), ...(end === undefined ? {} : { end: at(end) }) }
      }
    })
  }
  part(session: string, message: string, id: string, value: Json) {
    this.write(join(this.root, 'part', message, `${id}.json`), {
      id,
      sessionID: session,
      messageID: message,
      ...value
    })
  }
}
const tokens = (input: number, output: number, reasoning = 0, read = 0, write = 0) => ({
  input,
  output,
  reasoning,
  cache: { read, write }
})

async function capture(source: string, target = db): Promise<ParsedSessionData> {
  const parsed = (await parseOpencodeSessionFile(source))!
  expect(parsed.opencodeActivityEvidence?.status).toBe('captured')
  target.transaction((tx) => storeActivityEvidence(tx, parsed, '2026-09-26T05:00:00Z'))
  return parsed
}
function resolvedOnly(target = db, conversationId = 'ses_a') {
  const found = readCanonicalActivity(target).find(
    (entry) => entry.conversationId === conversationId
  )
  if (found?.status !== 'resolved')
    throw new Error(
      `Expected resolved OpenCode history, got ${found && 'reason' in found ? found.reason : 'none'}`
    )
  return found
}
function held(reason: string, target = db) {
  expect(readCanonicalActivity(target)).toEqual([
    expect.objectContaining({
      provider: 'opencode',
      conversationId: 'ses_a',
      status: 'unresolved',
      reason
    })
  ])
}
const summary = (interval: {
  startedAt: string
  endedAt: string
  durationMinutes: number
  promptCount: number
  inputTokens: number
  outputTokens: number
  modelUsage: unknown
}) => ({
  startedAt: interval.startedAt,
  endedAt: interval.endedAt,
  durationMinutes: interval.durationMinutes,
  promptCount: interval.promptCount,
  inputTokens: interval.inputTokens,
  outputTokens: interval.outputTokens,
  modelUsage: interval.modelUsage
})

/** A prompt answered by a two-step reply with a tool run, then a resumed prompt after idle. */
function conversation(store: Store) {
  const source = store.session('ses_a')
  store.prompt('ses_a', 'msg_01', 1)
  store.reply('ses_a', 'msg_02', 'msg_01', 1.1, {
    completed: 3,
    tokens: tokens(1000, 50, 10, 200)
  })
  store.tool('ses_a', 'msg_02', 'prt_02_tool', 1.5, 2.5)
  store.reply('ses_a', 'msg_03', 'msg_01', 3.1, {
    completed: 4,
    tokens: tokens(1500, 80, 0, 1000, 100)
  })
  store.prompt('ses_a', 'msg_04', 45)
  store.reply('ses_a', 'msg_05', 'msg_04', 45.2, {
    completed: 46,
    tokens: tokens(400, 20),
    model: 'other-model'
  })
  return source
}

it('resolves a multi-step reply and a resumed prompt to the parser intervals with unique tokens', async () => {
  const parsed = await capture(conversation(new Store(join(directory, 'a'))))
  const result = resolvedOnly()
  expect(result.recording.messages.map((message) => message.type)).toEqual([
    'user',
    'assistant',
    'assistant',
    'user',
    'assistant'
  ])
  expect(result.recording.messages.map((message) => message.uuid)).toEqual(
    parsed.messages.map((message) => message.activityIdentity!.eventId)
  )
  expect(result.recording.totalTokenUsage).toEqual(parsed.totalTokenUsage)
  expect(result.recording.totalTokenUsage).toEqual({
    inputTokens: 800 + 500 + 400,
    outputTokens: 60 + 80 + 20,
    cacheCreationInputTokens: 100,
    cacheReadInputTokens: 1200
  })
  expect(result.recording.models).toEqual(['fixture-model', 'other-model'])
  const tool = parsed.opencodeActivityEvidence!.activities.find(
    (activity) => activity.kind === 'tool'
  )!
  // One progress fact per tool run, at its recorded start; other parts are ancestry only.
  expect(result.events.filter((event) => event.kind === 'progress')).toMatchObject([
    { eventId: tool.identity.eventId, timestamp: iso(1.5) }
  ])
  expect(result.events.filter((event) => event.kind === 'message')).toHaveLength(5)
  expect(result.eventIds).toHaveLength(parsed.opencodeActivityEvidence!.activities.length)
  const observations = new Map(
    db
      .select()
      .from(activityObservations)
      .all()
      .map((entry) => [entry.id, entry])
  )
  for (const event of result.events) {
    expect(observations.get(event.observationId)?.eventId).toBe(event.eventId)
    expect(event).not.toHaveProperty('observationIds')
  }

  const intervals = calculateCanonicalIntervals(result, policy)
  expect(intervals.map(summary)).toEqual(detectSessionsWithPolicy([parsed], policy).map(summary))
  expect(
    intervals.map((interval) => [interval.startedAt, interval.endedAt, interval.promptCount])
  ).toEqual([
    [iso(1), iso(3.1), 1],
    [iso(45), iso(45.2), 1]
  ])
  expect(intervals.map((interval) => [interval.inputTokens, interval.outputTokens])).toEqual([
    [1300, 140],
    [400, 20]
  ])
  // Plain version 1 coverage that the saved-snapshot reader accepts for OpenCode.
  for (const interval of intervals) {
    expect(interval.coverage.version).toBe(1)
    expect(readCanonicalIntervalSnapshot(JSON.stringify(interval), 'opencode')).toEqual(interval)
  }
  expect(JSON.stringify(result)).not.toMatch(/PRIVATE_TRANSCRIPT|private-project|secret\.ts|msg_0/)

  adoptInitialWorkspacePolicy(db, {
    workspaceId: 'fb751832-c62e-4f27-bc3f-b6a7a8e31214',
    revisionId: 'fbd24e8f-4aa9-4420-889a-574e83cdd267',
    policy
  })
  const [preview] = previewLedgerWorkspacePolicy(db, policy).conversations
  expect(preview).toMatchObject({ provider: 'opencode', status: 'resolved' })
  if (preview.status !== 'resolved') throw new Error('Expected resolved preview')
  expect(preview.before).toEqual(intervals)
  expect(preview.unassigned.before).toEqual([])
})

it('orders a prompt and reply created in the same millisecond by native message ID', async () => {
  const store = new Store(join(directory, 'a'))
  const source = store.session('ses_a')
  store.prompt('ses_a', 'msg_01', 1)
  store.reply('ses_a', 'msg_02', 'msg_01', 1, { completed: 2, tokens: tokens(100, 10) })
  const parsed = await capture(source)
  const result = resolvedOnly()
  expect(result.recording.messages.map((message) => [message.type, message.timestamp])).toEqual([
    ['user', iso(1)],
    ['assistant', iso(1)]
  ])
  expect(calculateCanonicalIntervals(result, policy).map(summary)).toEqual(
    detectSessionsWithPolicy([parsed], policy).map(summary)
  )
})

it('holds a reply until it completes, then counts its final usage once across growth and copies', async () => {
  const live = new Store(join(directory, 'live'))
  const source = live.session('ses_a')
  live.prompt('ses_a', 'msg_01', 1)
  live.reply('ses_a', 'msg_02', 'msg_01', 1.1)
  live.tool('ses_a', 'msg_02', 'prt_02_tool', 1.5)
  await capture(source)
  held('incomplete-activity')

  // The same files, rewritten as OpenCode finishes the reply.
  live.tool('ses_a', 'msg_02', 'prt_02_tool', 1.5, 2.5)
  live.reply('ses_a', 'msg_02', 'msg_01', 1.1, { completed: 3, tokens: tokens(1000, 50, 10, 200) })
  const parsed = await capture(source)
  deviceId = '7c8f7eab-af58-4cbb-9e74-d1e47f80d600'
  const copy = new Store(join(directory, 'copy'))
  copy.session('ses_a')
  copy.prompt('ses_a', 'msg_01', 1)
  copy.reply('ses_a', 'msg_02', 'msg_01', 1.1, { completed: 3, tokens: tokens(1000, 50, 10, 200) })
  copy.tool('ses_a', 'msg_02', 'prt_02_tool', 1.5, 2.5)
  await capture(join(copy.root, 'session', 'project', 'ses_a.json'))

  const grown = resolvedOnly()
  expect(grown.recording.totalTokenUsage).toEqual(parsed.totalTokenUsage)
  expect(grown.recording.totalTokenUsage.inputTokens).toBe(800)
  // Superseded running observations stay retained but are not cited or counted.
  expect(grown.observationIds.length).toBeGreaterThan(grown.eventIds.length)

  const clean = database()
  await capture(source, clean.target)
  const expected = resolvedOnly(clean.target)
  expect(grown.recording).toEqual(expected.recording)
  expect(grown.events).toEqual(expected.events)
  expect(calculateCanonicalIntervals(grown, policy)).toEqual(
    calculateCanonicalIntervals(expected, policy)
  )
})

it('resolves identical history on two independent databases regardless of capture order', async () => {
  const first = new Store(join(directory, 'desktop'))
  const second = new Store(join(directory, 'laptop'))
  const sourceA = conversation(first)
  const sourceB = conversation(second)
  const laptop = database()
  // Desktop sees the subagent first; the laptop sees it last.
  const child = first.session('ses_child', { parentID: 'ses_a' })
  second.session('ses_child', { parentID: 'ses_a' })
  for (const store of [first, second]) {
    store.prompt('ses_child', 'msg_10', 1.6)
    store.reply('ses_child', 'msg_11', 'msg_10', 1.7, { completed: 2.4, tokens: tokens(300, 30) })
  }
  await capture(child)
  await capture(sourceA)
  deviceId = '7c8f7eab-af58-4cbb-9e74-d1e47f80d600'
  await capture(sourceB, laptop.target)
  await capture(join(second.root, 'session', 'project', 'ses_child.json'), laptop.target)
  expect(readCanonicalActivity(laptop.target)).toEqual(readCanonicalActivity(db))

  // The subagent is its own conversation: its tokens are counted once, never in the parent.
  const parent = resolvedOnly()
  const subagent = resolvedOnly(db, 'ses_child')
  expect(parent.recording.totalTokenUsage.inputTokens).toBe(1700)
  expect(subagent.recording.totalTokenUsage.inputTokens).toBe(300)
  expect(new Set([...parent.eventIds, ...subagent.eventIds]).size).toBe(
    parent.eventIds.length + subagent.eventIds.length
  )
})

function rewrite(eventId: string, change: (payload: Json) => void) {
  for (const observation of db.select().from(activityObservations).all()) {
    if (observation.eventId !== eventId) continue
    const payload = JSON.parse(observation.payloadJson)
    change(payload)
    sqlite
      .prepare('UPDATE activity_observations SET payload_json = ? WHERE id = ?')
      .run(JSON.stringify(payload), observation.id)
  }
}
const eventOf = (parsed: ParsedSessionData, nativeId: string) =>
  parsed.opencodeActivityEvidence!.activities.find(
    (activity) => activity.identity.nativeEventId === nativeId
  )!.identity.eventId

it.each([
  [
    'branching-messages',
    'a reply to an earlier prompt after a newer prompt',
    (store: Store) => {
      store.prompt('ses_a', 'msg_01', 1)
      store.prompt('ses_a', 'msg_02', 2)
      store.reply('ses_a', 'msg_03', 'msg_01', 3, { completed: 4 })
    }
  ],
  [
    'unknown-ancestry',
    'a reply without its prompt link',
    (store: Store) => {
      store.prompt('ses_a', 'msg_01', 1)
      store.reply('ses_a', 'msg_02', undefined, 2, { completed: 3 })
    }
  ],
  [
    'missing-predecessor',
    'a reply to a prompt that was never captured',
    (store: Store) => {
      store.prompt('ses_a', 'msg_01', 1)
      store.reply('ses_a', 'msg_02', 'msg_00', 2, { completed: 3 })
    }
  ],
  [
    'invalid-observation',
    'a reply to another reply',
    (store: Store) => {
      store.prompt('ses_a', 'msg_01', 1)
      store.reply('ses_a', 'msg_02', 'msg_01', 2, { completed: 3 })
      store.reply('ses_a', 'msg_03', 'msg_02', 4, { completed: 5 })
    }
  ],
  [
    'nonmonotonic-time',
    'a tool run recorded before its reply',
    (store: Store) => {
      store.prompt('ses_a', 'msg_01', 1)
      store.reply('ses_a', 'msg_02', 'msg_01', 2, { completed: 3 })
      store.tool('ses_a', 'msg_02', 'prt_02_tool', 1.5, 2.5)
    }
  ]
])('holds %s: %s', async (reason, _label, build) => {
  const store = new Store(join(directory, 'a'))
  const source = store.session('ses_a')
  build(store)
  await capture(source)
  held(reason)
})

it('holds a corrected completed reply instead of choosing a winner', async () => {
  const first = new Store(join(directory, 'a'))
  const source = conversation(first)
  await capture(source)
  const second = new Store(join(directory, 'b'))
  conversation(second)
  second.reply('ses_a', 'msg_05', 'msg_04', 45.2, {
    completed: 46,
    tokens: tokens(999, 20),
    model: 'other-model'
  })
  await capture(join(second.root, 'session', 'project', 'ses_a.json'))
  held('conflicting-observations')
})

it('holds observations that disagree about the parent conversation', async () => {
  const parsed = await capture(conversation(new Store(join(directory, 'a'))))
  rewrite(eventOf(parsed, 'msg_04'), (payload) => {
    payload.parentConversationId = 'ses_other'
  })
  held('conflicting-observations')
})

it.each([
  [
    'a prompt with usage',
    'msg_01',
    (payload: Json) =>
      (payload.usage = {
        inputTokens: 1,
        outputTokens: 0,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0
      })
  ],
  ['a tool result prompt', 'msg_01', (payload: Json) => (payload.isToolResult = true)],
  [
    'a zone-less timestamp',
    'msg_02',
    (payload: Json) => (payload.timestamp = '2026-09-26T03:01:00')
  ],
  ['an unknown field', 'msg_02', (payload: Json) => (payload.cwd = 'C:/private-project')],
  [
    'timing on a text part',
    'prt_msg_01_text',
    (payload: Json) => (payload.timing = { startedAt: iso(1) })
  ]
])('rejects %s outside the captured format', async (_label, nativeId, change) => {
  const parsed = await capture(conversation(new Store(join(directory, 'a'))))
  rewrite(eventOf(parsed, nativeId), change)
  held('invalid-observation')
})
