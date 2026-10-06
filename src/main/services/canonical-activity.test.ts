// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { spawnSync } from 'node:child_process'
import { buildSync } from 'esbuild'
import { activityIdentities, activityObservations } from '../db/schema/activity-evidence'
import { parseSessionFile } from '../parsers/session-parser'
import { parseGeminiSessionFile } from '../parsers/gemini-parser'
import { parseOpencodeSessionFile } from '../parsers/opencode-parser'
import { parseCodexSessionFile } from '../parsers/codex-parser'
import { storeActivityEvidence } from './activity-evidence'
import {
  readCanonicalActivity,
  retainsCanonicalEvent,
  type CanonicalEventReference
} from './canonical-activity'
import { readCanonicalCoverageUsage } from './canonical-codex'
import { relateCanonicalIntervals, type CanonicalIntervalCoverage } from './canonical-intervals'
import { detectSessionsWithPolicy } from './session-detector'
import { adoptInitialWorkspacePolicy, previewLedgerWorkspacePolicy } from './workspace-policy'

vi.mock('electron-log/main.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
}))
let deviceId = '9b95ec41-b3b6-4cbb-b1b6-e7ce607ef222'
vi.mock('./device-context', () => ({
  getLocalDeviceSession: () => ({ deviceId, machineName: 'Fixture machine' })
}))
let sqlite: Database.Database
let db: ReturnType<typeof drizzle>
let directory: string
const migrationsFolder = join(__dirname, '../db/migrations')
const policy = {
  version: 1,
  normalizationVersion: 1,
  detectorVersion: 1,
  idleTimeoutMinutes: 15,
  reportingTimeZone: 'UTC'
}
const snapshot = {
  workspaceId: 'fb751832-c62e-4f27-bc3f-b6a7a8e31214',
  revisionId: 'fbd24e8f-4aa9-4420-889a-574e83cdd267',
  policy
}
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'clautime-canonical-'))
  sqlite = new Database(':memory:')
  sqlite.pragma('foreign_keys = ON')
  db = drizzle(sqlite)
  migrate(db, { migrationsFolder })
  deviceId = '9b95ec41-b3b6-4cbb-b1b6-e7ce607ef222'
})
afterEach(() => {
  sqlite.close()
  const target = resolve(directory)
  if (!target.startsWith(resolve(tmpdir()) + sep) || !target.includes('clautime-canonical-'))
    throw new Error('Unexpected fixture directory')
  rmSync(target, { recursive: true, force: true })
})

function message(uuid: string, parentUuid: string | null, minute: number, type = 'user') {
  return {
    type,
    uuid,
    parentUuid,
    sessionId: 'conversation-a',
    timestamp: `2026-09-26T03:${String(minute).padStart(2, '0')}:00Z`,
    cwd: 'C:/private-project',
    message: {
      role: type,
      model: 'fixture-model',
      content: [{ type: 'text', text: 'PRIVATE_TRANSCRIPT' }],
      ...(type === 'assistant' ? { usage: { input_tokens: 100, output_tokens: 20 } } : {})
    }
  }
}
function linear() {
  return [
    message('one', null, 40),
    message('two', 'one', 50, 'assistant'),
    message('three', 'two', 55)
  ]
}
async function store(records: unknown[], name = 'source.jsonl') {
  const path = join(directory, name)
  writeFileSync(path, records.map((record) => JSON.stringify(record)).join('\n') + '\n')
  const parsed = (await parseSessionFile(path))!
  db.transaction((tx) => storeActivityEvidence(tx, parsed, '2026-09-26T05:00:00Z'))
  return parsed
}
function reason(expected: string, provider = 'claude') {
  expect(readCanonicalActivity(db)).toEqual([
    expect.objectContaining({
      provider,
      conversationId: 'conversation-a',
      status: 'unresolved',
      reason: expected
    })
  ])
}
function rewritePayload(change: (payload: Record<string, unknown>) => void, eventId?: string) {
  const observation = db
    .select()
    .from(activityObservations)
    .all()
    .find((entry) => eventId === undefined || entry.eventId === eventId)!
  const payload = JSON.parse(observation.payloadJson)
  change(payload)
  sqlite
    .prepare('UPDATE activity_observations SET payload_json = ? WHERE id = ?')
    .run(JSON.stringify(payload), observation.id)
}

it('deduplicates copies and observers, retains source-less input and follows ancestry at equal times', async () => {
  const records = linear()
  records[1].timestamp = records[0].timestamp
  const parsed = await store(records)
  deviceId = '7c8f7eab-af58-4cbb-9e74-d1e47f80d600'
  await store([...records].reverse(), 'copied.jsonl')
  rmSync(parsed.sourceFile)
  sqlite.exec('DELETE FROM activity_sources')
  const result = readCanonicalActivity(db)
  expect(result).toHaveLength(1)
  expect(result[0].status).toBe('resolved')
  if (result[0].status !== 'resolved') throw new Error('Expected resolved input')
  expect(result[0].eventIds).toHaveLength(3)
  expect(result[0].observationIds).toHaveLength(3)
  expect(result[0].recording.messages.map((entry) => entry.type)).toEqual([
    'user',
    'assistant',
    'user'
  ])
  expect(result[0].recording.totalTokenUsage).toMatchObject({ inputTokens: 100, outputTokens: 20 })
  expect(JSON.stringify(result)).not.toMatch(/private-project|PRIVATE_TRANSCRIPT|copied.jsonl/)
  const copy = new Database(sqlite.serialize())
  try {
    expect(readCanonicalActivity(drizzle(copy))).toEqual(result)
  } finally {
    copy.close()
  }
})

it('uses retained progress to bridge a tool gap without counting progress as messages', async () => {
  const start = message('one', null, 0, 'assistant')
  start.message.content = [
    { type: 'tool_use', text: 'unused', name: 'Bash' } as (typeof start.message.content)[number]
  ]
  const end = { ...message('two', 'one', 40), toolUseResult: { stdout: 'fixture' } }
  end.message.content = [{ type: 'tool_result', text: 'unused' }]
  await store([
    start,
    ...[10, 20, 30].map((minute) => ({
      type: 'progress',
      uuid: `progress-${minute}`,
      parentUuid: 'one',
      sessionId: 'conversation-a',
      timestamp: `2026-09-26T03:${minute}:00Z`,
      data: { type: 'bash_progress' }
    })),
    end
  ])
  adoptInitialWorkspacePolicy(db, snapshot)
  const result = previewLedgerWorkspacePolicy(db, policy)
  expect(result.conversations[0]).toMatchObject({
    status: 'resolved',
    before: [{ durationMinutes: 40, promptCount: 0, inputTokens: 100 }]
  })
})

it('follows message ancestry through intermediate progress records', async () => {
  await store([
    message('one', null, 0),
    {
      type: 'progress',
      uuid: 'progress',
      parentUuid: 'one',
      sessionId: 'conversation-a',
      timestamp: '2026-09-26T03:01:00Z',
      data: { type: 'bash_progress' }
    },
    message('two', 'progress', 2)
  ])
  const result = readCanonicalActivity(db)[0]
  expect(result.status).toBe('resolved')
  if (result.status === 'resolved') expect(result.recording.messageCount).toBe(2)
})

it('holds usage corrections outside calculation while independent conversations still resolve', async () => {
  await store(linear())
  const corrected = linear()
  corrected[1].message.usage!.input_tokens = 200
  await store(corrected, 'correction.jsonl')
  await store([{ ...message('other', null, 45), sessionId: 'conversation-b' }], 'independent.jsonl')
  adoptInitialWorkspacePolicy(db, snapshot)
  const result = previewLedgerWorkspacePolicy(db, policy)
  expect(result.conversations[0]).toMatchObject({
    status: 'unresolved',
    reason: 'conflicting-observations'
  })
  expect(result.conversations[0]).not.toHaveProperty('before')
  expect(result.conversations[1]).toMatchObject({
    status: 'resolved',
    before: [{ promptCount: 1 }]
  })
})

it.each([
  ['missing-predecessor', [message('one', 'missing', 0)]],
  ['ambiguous-roots', [message('one', null, 0), message('two', null, 1)]],
  [
    'branching-messages',
    [message('one', null, 0), message('two', 'one', 1), message('three', 'one', 2)]
  ],
  ['cyclic-ancestry', [message('one', 'two', 0), message('two', 'one', 0)]],
  [
    'cyclic-ancestry',
    [message('root', null, 0), message('one', 'two', 0), message('two', 'one', 0)]
  ],
  ['nonmonotonic-time', [message('one', null, 5), message('two', 'one', 0)]]
])('holds %s without flattening distinct or incomplete history', async (expected, records) => {
  await store(records)
  reason(expected)
})

it('treats cross-conversation references as missing ancestry', async () => {
  await store(linear())
  const id = db
    .select()
    .from(activityIdentities)
    .all()
    .find((entry) => entry.nativeEventId === 'two')!
  sqlite
    .prepare('UPDATE activity_identities SET conversation_id = ? WHERE event_id = ?')
    .run('other', id.eventId)
  expect(readCanonicalActivity(db).every((entry) => entry.status === 'unresolved')).toBe(true)
})

it.each([
  [
    'invalid-observation',
    (value: Record<string, unknown>) => {
      value.type = ['user']
    }
  ],
  [
    'unknown-ancestry',
    (value: Record<string, unknown>) => {
      delete value.parentEventId
    }
  ],
  [
    'invalid-observation',
    (value: Record<string, unknown>) => {
      value.timestamp = '2026-09-26T03:00:00'
    }
  ],
  [
    'invalid-observation',
    (value: Record<string, unknown>) => {
      value.usage = { inputTokens: -1 }
    }
  ],
  [
    'invalid-observation',
    (value: Record<string, unknown>) => {
      value.toolNames = [5]
    }
  ],
  [
    'invalid-observation',
    (value: Record<string, unknown>) => {
      value.futureField = true
    }
  ]
])('rejects incomplete or invalid captured payloads (%#)', async (expected, change) => {
  await store(linear())
  rewritePayload(change)
  reason(expected)
})

it.each([
  ['unsupported-version', 'UPDATE activity_identities SET identity_version = 2'],
  ['unsupported-version', 'UPDATE activity_observations SET version = 2'],
  ['unsupported-version', "UPDATE activity_identities SET basis = 'future'"],
  [
    'missing-observation',
    'DELETE FROM activity_observers; DELETE FROM activity_sources; DELETE FROM activity_observations'
  ],
  ['invalid-observation', "UPDATE activity_observations SET payload_json = '{broken'"]
])('holds incompatible or absent observations (%#)', async (expected, sql) => {
  await store(linear())
  sqlite.exec(sql)
  reason(expected)
})

// Codex and OpenCode have their own adapters (canonical-codex/canonical-opencode tests).
it.each(['future'])(
  'exposes unsupported %s conversations instead of dropping them',
  async (provider) => {
    await store(linear())
    sqlite.prepare('UPDATE activity_identities SET provider = ?').run(provider)
    expect(readCanonicalActivity(db)[0]).toMatchObject({
      provider,
      status: 'unresolved',
      reason: 'unsupported-provider'
    })
  }
)

it('does not infer message time or counts from progress-only history', async () => {
  await store([
    {
      type: 'progress',
      uuid: 'progress',
      parentUuid: null,
      sessionId: 'conversation-a',
      timestamp: '2026-09-26T03:00:00Z',
      data: { type: 'bash_progress' }
    }
  ])
  reason('no-messages')
})

const geminiUser = {
  id: 'user-1',
  timestamp: '2026-09-26T03:00:00.000Z',
  type: 'user',
  content: [{ text: 'PRIVATE_TRANSCRIPT' }]
}
const geminiInfo = {
  id: 'info-1',
  timestamp: '2026-09-26T03:01:00.000Z',
  type: 'info',
  content: 'PRIVATE_TRANSCRIPT'
}
const geminiReply = {
  id: 'response-1',
  timestamp: '2026-09-26T03:02:00.000Z',
  type: 'gemini',
  content: 'PRIVATE_TRANSCRIPT',
  model: 'fixture-model',
  tokens: { input: 100, cached: 20, output: 10, thoughts: 3, tool: 2, total: 115 }
}
async function storeGemini(records: unknown[], name = 'session-a.json') {
  const chats = join(directory, 'gemini', 'chats')
  mkdirSync(chats, { recursive: true })
  const path = join(chats, name)
  writeFileSync(path, JSON.stringify({ sessionId: 'conversation-a', messages: records }))
  const parsed = (await parseGeminiSessionFile(path))!
  expect(parsed.geminiActivityEvidence?.status).toBe('captured')
  db.transaction((tx) => storeActivityEvidence(tx, parsed, '2026-09-26T05:00:00Z'))
  return parsed
}

it('resolves a linear Gemini snapshot once across copies with per-model usage and recorded progress', async () => {
  const records = [
    geminiUser,
    geminiInfo,
    {
      ...geminiReply,
      toolCalls: [{ id: 'call-1', name: 'read_file', args: { path: 'C:/private-project' } }],
      thoughts: [{ description: 'PRIVATE_TRANSCRIPT', timestamp: '2026-09-26T03:09:00.000Z' }]
    },
    { ...geminiUser, id: 'user-2', timestamp: '2026-09-26T05:10:00+02:00' },
    // No native ID: the parser's fingerprint identity, not a synthetic one.
    {
      ...geminiReply,
      id: undefined,
      timestamp: '2026-09-26T03:12:00Z',
      model: 'other-model',
      tokens: { input: 50, output: 5 }
    }
  ]
  const parsed = await storeGemini(records)
  deviceId = '7c8f7eab-af58-4cbb-9e74-d1e47f80d600'
  await storeGemini(records, 'copy.json')
  const result = readCanonicalActivity(db)
  expect(result).toHaveLength(1)
  if (result[0].status !== 'resolved') throw new Error('Expected resolved input')
  const { recording } = result[0]
  expect(result[0].provider).toBe('gemini')
  expect(result[0].observationIds).toHaveLength(5)
  expect([...result[0].eventIds].sort()).toEqual(
    parsed.geminiActivityEvidence!.activities.map((activity) => activity.identity.eventId).sort()
  )
  // Recorded array ancestry, not the local parser's raw-string timestamp sort.
  expect(recording.messages.map((entry) => entry.uuid)).toEqual(
    parsed
      .geminiActivityEvidence!.activities.filter((activity) => activity.kind !== 'info')
      .map((activity) => activity.identity.eventId)
  )
  expect(recording.messages.map((entry) => [entry.type, entry.timestamp])).toEqual([
    ['user', '2026-09-26T03:00:00.000Z'],
    ['assistant', '2026-09-26T03:02:00.000Z'],
    ['user', '2026-09-26T03:10:00.000Z'],
    ['assistant', '2026-09-26T03:12:00.000Z']
  ])
  expect(recording.messages[1]).toMatchObject({ hasToolUse: true, toolNames: ['read_file'] })
  expect(recording).toMatchObject({
    tool: 'gemini',
    models: ['fixture-model', 'other-model'],
    totalTokenUsage: parsed.totalTokenUsage
  })
  // Thought timestamps are not captured as observations, so they are not invented here.
  expect(parsed.progressTimestamps).toContain('2026-09-26T03:09:00.000Z')
  expect(recording.progressTimestamps).toEqual(['2026-09-26T03:01:00.000Z'])
  expect(JSON.stringify(result)).not.toMatch(/private-project|PRIVATE_TRANSCRIPT|copy.json/)

  adoptInitialWorkspacePolicy(db, snapshot)
  const preview = resolvedPreview()
  expectVersionOne(preview)
  expect(preview.before).toMatchObject([
    {
      durationMinutes: 12,
      promptCount: 2,
      inputTokens: 132,
      outputTokens: 18,
      modelUsage: [
        {
          model: 'fixture-model',
          inputTokens: 82,
          outputTokens: 13,
          cacheCreationInputTokens: 0,
          cacheReadInputTokens: 20
        },
        {
          model: 'other-model',
          inputTokens: 50,
          outputTokens: 5,
          cacheCreationInputTokens: 0,
          cacheReadInputTokens: 0
        }
      ]
    }
  ])
  const observations = db.select().from(activityObservations).all()
  for (const event of result[0].events)
    expect(observations.find((entry) => entry.id === event.observationId)?.eventId).toBe(
      event.eventId
    )
})

it('counts a repeated native Gemini record inside one snapshot once', async () => {
  const tail = { ...geminiUser, id: 'user-2', timestamp: '2026-09-26T03:05:00.000Z' }
  const parsed = await storeGemini([geminiUser, geminiReply, geminiUser, tail])
  expect(parsed.messages).toHaveLength(4)
  const result = readCanonicalActivity(db)[0]
  if (result.status !== 'resolved') throw new Error('Expected resolved input')
  const ids = parsed.geminiActivityEvidence!.activities.map((activity) => activity.identity.eventId)
  expect(result.observationIds).toHaveLength(3)
  expect(result.recording.messages.map((entry) => entry.uuid)).toEqual([ids[0], ids[1], ids[3]])
})

it.each([
  ['usage arriving later', { ...geminiReply, tokens: undefined }, geminiReply],
  ['a corrected model', geminiReply, { ...geminiReply, model: 'corrected' }],
  [
    'an embedded tool call arriving later',
    geminiReply,
    { ...geminiReply, toolCalls: [{ name: 'read_file' }] }
  ]
])('holds Gemini snapshots with %s as unselected corrections', async (_label, earlier, later) => {
  await storeGemini([geminiUser, earlier])
  await storeGemini([geminiUser, later], 'later.json')
  reason('conflicting-observations', 'gemini')
})

it.each([
  [
    'branching-messages',
    [
      [geminiUser, geminiReply],
      [geminiUser, { ...geminiReply, id: 'response-2' }]
    ]
  ],
  [
    'branching-messages',
    [
      [geminiUser, { ...geminiReply, id: undefined }],
      [geminiUser, { ...geminiReply, id: undefined, content: 'Different.' }]
    ]
  ],
  ['nonmonotonic-time', [[geminiReply, geminiUser]]],
  [
    'unscoped-progress',
    [[{ ...geminiInfo, timestamp: '2026-09-26T02:59:00.000Z' }, geminiUser, geminiReply]]
  ]
])('holds Gemini %s snapshots without inventing a linear order', async (expected, snapshots) => {
  for (const [index, records] of snapshots.entries())
    await storeGemini(records, `session-${index}.json`)
  reason(expected, 'gemini')
})

it.each([
  [
    'invalid-observation',
    1,
    (value: Record<string, unknown>) => {
      value.kind = 'gemini'
    }
  ],
  [
    'invalid-observation',
    1,
    (value: Record<string, unknown>) => {
      value.progressType = 'info'
    }
  ],
  [
    'invalid-observation',
    2,
    (value: Record<string, unknown>) => {
      value.type = 'system'
    }
  ],
  [
    'invalid-observation',
    0,
    (value: Record<string, unknown>) => {
      value.isToolResult = true
    }
  ],
  [
    'unknown-ancestry',
    2,
    (value: Record<string, unknown>) => {
      delete value.parentEventId
    }
  ],
  [
    'missing-predecessor',
    2,
    (value: Record<string, unknown>) => {
      value.parentEventId = 'gemini:v1:native:missing'
    }
  ]
])('rejects Gemini payloads outside the captured format (%#)', async (expected, index, change) => {
  const parsed = await storeGemini([geminiUser, geminiInfo, geminiReply])
  rewritePayload(change, parsed.geminiActivityEvidence!.activities[index].identity.eventId)
  reason(expected, 'gemini')
})

it('resolves captured OpenCode history through its adapter although prompts record no predecessor', async () => {
  const root = join(directory, 'opencode', 'storage')
  const created = Date.parse('2026-09-26T03:00:00Z')
  const write = (path: string, value: unknown) => {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, JSON.stringify(value))
  }
  const source = join(root, 'session', 'project', 'ses_a.json')
  write(source, { id: 'ses_a', directory: 'C:/private-project' })
  write(join(root, 'message', 'ses_a', 'msg_user.json'), {
    id: 'msg_user',
    sessionID: 'ses_a',
    role: 'user',
    time: { created }
  })
  write(join(root, 'message', 'ses_a', 'msg_reply.json'), {
    id: 'msg_reply',
    sessionID: 'ses_a',
    role: 'assistant',
    parentID: 'msg_user',
    time: { created: created + 1000, completed: created + 2000 },
    modelID: 'fixture-model',
    tokens: { input: 100, output: 10 }
  })
  write(join(root, 'part', 'msg_user', 'prt_text.json'), {
    id: 'prt_text',
    sessionID: 'ses_a',
    messageID: 'msg_user',
    type: 'text',
    text: 'PRIVATE_TRANSCRIPT'
  })
  write(join(root, 'part', 'msg_reply', 'prt_tool.json'), {
    id: 'prt_tool',
    sessionID: 'ses_a',
    messageID: 'msg_reply',
    type: 'tool',
    tool: 'read',
    state: { status: 'completed', time: { start: created + 1100, end: created + 1500 } }
  })
  const parsed = (await parseOpencodeSessionFile(source))!
  expect(parsed.opencodeActivityEvidence!.status).toBe('captured')
  expect(parsed.messages[0].activityIdentity!.parentEventId).toBeUndefined()
  db.transaction((tx) => storeActivityEvidence(tx, parsed, '2026-09-26T05:00:00Z'))
  const result = readCanonicalActivity(db)
  expect(result).toEqual([
    expect.objectContaining({
      provider: 'opencode',
      conversationId: 'ses_a',
      status: 'resolved'
    })
  ])
  expect(result[0].eventIds).toHaveLength(4)
  expect(result[0].observationIds).toHaveLength(4)
  if (result[0].status !== 'resolved') throw new Error('Expected resolved OpenCode history')
  // Prompt, reply and the reply's tool run; the prompt's text part is ancestry only.
  expect(result[0].events.map((event) => event.kind)).toEqual(['message', 'message', 'progress'])
  expect(result[0].recording.totalTokenUsage).toEqual(parsed.totalTokenUsage)
  expect(JSON.stringify(result)).not.toMatch(/private-project|PRIVATE_TRANSCRIPT/)
})

function resolvedPreview(candidate = policy) {
  const conversation = previewLedgerWorkspacePolicy(db, candidate).conversations[0]
  if (conversation.status !== 'resolved') throw new Error('Expected resolved conversation')
  return conversation
}
type Preview = ReturnType<typeof resolvedPreview>
const plain = (event: CanonicalEventReference) => ({
  eventId: event.eventId,
  observationId: event.observationId,
  kind: event.kind,
  timestamp: event.timestamp
})
/** Byte-for-byte the pre-Codex snapshot shape: no usage, observation lists or usage report. */
function expectVersionOne(preview: Preview) {
  expect(preview).not.toHaveProperty('unassignedUsage')
  expect(Object.keys(preview.unassigned)).toEqual(['before', 'after'])
  for (const { coverage } of [...preview.before, ...preview.after])
    expect(JSON.stringify(coverage)).toBe(
      JSON.stringify({
        version: 1,
        messages: coverage.messages.map(plain),
        continuity: coverage.continuity.map((edge) => ({
          from: plain(edge.from),
          to: plain(edge.to),
          startedAt: edge.startedAt,
          endedAt: edge.endedAt,
          progress: edge.progress.map(plain)
        }))
      })
    )
}
function at(uuid: string, parent: string | null, timestamp: string, type = 'user') {
  return { ...message(uuid, parent, 0, type), timestamp }
}

it('retains exact message/observation references in ancestry order when timestamps are equal', async () => {
  const parsed = await store([
    at('one', null, '2026-09-26T03:00:00Z'),
    at('two', 'one', '2026-09-26T03:00:00Z', 'assistant'),
    at('three', 'two', '2026-09-26T03:00:00Z')
  ])
  adoptInitialWorkspacePolicy(db, snapshot)
  const result = resolvedPreview()
  expect(result.before[0].coverage.messages.map((event) => event.eventId)).toEqual(
    parsed.messages.map((entry) => entry.activityIdentity!.eventId)
  )
  const observations = db.select().from(activityObservations).all()
  for (const event of result.before[0].coverage.messages)
    expect(observations.find((entry) => entry.id === event.observationId)?.eventId).toBe(
      event.eventId
    )
  expect(result.before[0].coverage.continuity).toEqual([])
  expect(result.before[0]).toMatchObject({ promptCount: 2, inputTokens: 100, outputTokens: 20 })
  expect(result.unassigned).toEqual({ before: [], after: [] })
})

it('assigns an exact-midnight message and its usage to only the detector-selected interval', async () => {
  const parsed = await store([
    at('one', null, '2026-09-26T03:55:00Z'),
    at('two', 'one', '2026-09-26T04:00:00Z', 'assistant'),
    at('three', 'two', '2026-09-26T04:05:00Z')
  ])
  adoptInitialWorkspacePolicy(db, snapshot)
  const result = resolvedPreview({ ...policy, reportingTimeZone: 'America/New_York' })
  const ids = parsed.messages.map((entry) => entry.activityIdentity!.eventId)
  expect(
    result.after.map((interval) => interval.coverage.messages.map((event) => event.eventId))
  ).toEqual([[ids[0]], [ids[1], ids[2]]])
  expect(result.after.map((interval) => interval.inputTokens)).toEqual([0, 100])
  expect(result.after.map((interval) => interval.promptCount)).toEqual([1, 1])
  expect(result.after[0].coverage.continuity[0]).toMatchObject({
    from: { eventId: ids[0] },
    to: { eventId: ids[1] },
    endedAt: '2026-09-26T04:00:00.000Z'
  })
  expect(result.after[1].coverage.continuity[0]).toMatchObject({
    from: { eventId: ids[1] },
    to: { eventId: ids[2] },
    startedAt: '2026-09-26T04:00:00.000Z'
  })
})

it('splits one continuous message pair at midnight without duplicating message membership', async () => {
  const parsed = await store([
    at('one', null, '2026-09-26T03:55:00Z'),
    at('two', 'one', '2026-09-26T04:05:00Z')
  ])
  adoptInitialWorkspacePolicy(db, snapshot)
  const result = resolvedPreview({ ...policy, reportingTimeZone: 'America/New_York' })
  const ids = parsed.messages.map((entry) => entry.activityIdentity!.eventId)
  expect(
    result.after.map((interval) => interval.coverage.messages.map((event) => event.eventId))
  ).toEqual([[ids[0]], [ids[1]]])
  expect(result.after.map((interval) => interval.coverage.continuity[0])).toMatchObject([
    {
      from: { eventId: ids[0] },
      to: { eventId: ids[1] },
      startedAt: '2026-09-26T03:55:00.000Z',
      endedAt: '2026-09-26T04:00:00.000Z'
    },
    {
      from: { eventId: ids[0] },
      to: { eventId: ids[1] },
      startedAt: '2026-09-26T04:00:00.000Z',
      endedAt: '2026-09-26T04:05:00.000Z'
    }
  ])
  expect(
    result.transitions.map((transition) =>
      transition.predecessors.map((entry) => entry.beforeIndex)
    )
  ).toEqual([[0], [0]])
  expect(result.after.reduce((sum, interval) => sum + interval.durationMinutes, 0)).toBe(10)
})

it('reports both canonical predecessors when a reporting policy merges midnight fragments', async () => {
  await store([at('one', null, '2026-09-26T03:55:00Z'), at('two', 'one', '2026-09-26T04:05:00Z')])
  adoptInitialWorkspacePolicy(db, {
    ...snapshot,
    policy: { ...policy, reportingTimeZone: 'America/New_York' }
  })
  const result = resolvedPreview()
  expect(result.transitions[0].predecessors.map((entry) => entry.beforeIndex)).toEqual([0, 1])
  expect(result.transitions[0].predecessors.map((entry) => entry.sharedContinuity)).toMatchObject([
    [{ startedAt: '2026-09-26T03:55:00.000Z', endedAt: '2026-09-26T04:00:00.000Z' }],
    [{ startedAt: '2026-09-26T04:00:00.000Z', endedAt: '2026-09-26T04:05:00.000Z' }]
  ])
})

it('retains a predecessor linked only by a shared portion of the same message pair', async () => {
  await store([at('one', null, '2026-09-26T02:00:00Z'), at('two', 'one', '2026-09-26T06:00:00Z')])
  adoptInitialWorkspacePolicy(db, {
    ...snapshot,
    policy: { ...policy, idleTimeoutMinutes: 300, reportingTimeZone: 'America/New_York' }
  })
  const result = resolvedPreview({
    ...policy,
    idleTimeoutMinutes: 300,
    reportingTimeZone: 'America/Halifax'
  })
  expect(result.transitions[1].predecessors[0]).toMatchObject({
    beforeIndex: 0,
    sharedMessageEventIds: [],
    sharedContinuity: [
      { startedAt: '2026-09-26T03:00:00.000Z', endedAt: '2026-09-26T04:00:00.000Z' }
    ]
  })
  expect(result.transitions[1].predecessors.map((entry) => entry.beforeIndex)).toEqual([0, 1])
})

it('partitions retained tool progress across a clipped gap and assigns boundary progress once', async () => {
  const first = at('one', null, '2026-09-26T03:40:00Z', 'assistant')
  first.message.content = [
    { type: 'tool_use', name: 'Bash' } as unknown as (typeof first.message.content)[number]
  ]
  await store([
    first,
    ...['03:50', '04:00', '04:10'].map((time) => ({
      type: 'progress',
      uuid: time,
      parentUuid: 'one',
      sessionId: 'conversation-a',
      timestamp: `2026-09-26T${time}:00Z`,
      data: { type: 'bash_progress' }
    })),
    { ...at('two', 'one', '2026-09-26T04:20:00Z'), toolUseResult: { stdout: 'fixture' } }
  ])
  adoptInitialWorkspacePolicy(db, snapshot)
  const result = resolvedPreview({ ...policy, reportingTimeZone: 'America/New_York' })
  expect(result.after.map((interval) => interval.durationMinutes)).toEqual([20, 20])
  expect(
    result.after.map((interval) =>
      interval.coverage.continuity[0].progress.map((event) => event.timestamp)
    )
  ).toEqual([
    ['2026-09-26T03:50:00.000Z'],
    ['2026-09-26T04:00:00.000Z', '2026-09-26T04:10:00.000Z']
  ])
  expect(result.unassigned.after).toEqual([])
  expect(result.after.map((interval) => interval.inputTokens)).toEqual([100, 0])
})

it('never turns idle gaps into continuity and exposes progress not allocated by the detector', async () => {
  await store([
    at('one', null, '2026-09-26T03:00:00Z'),
    {
      type: 'progress',
      uuid: 'idle-progress',
      parentUuid: 'one',
      sessionId: 'conversation-a',
      timestamp: '2026-09-26T03:20:00Z',
      data: { type: 'hook_progress' }
    },
    at('two', 'one', '2026-09-26T03:40:00Z')
  ])
  adoptInitialWorkspacePolicy(db, snapshot)
  const result = resolvedPreview()
  expect(result.before.map((interval) => interval.coverage.continuity)).toEqual([[], []])
  expect(result.unassigned.before).toMatchObject([
    { kind: 'progress', timestamp: '2026-09-26T03:20:00.000Z' }
  ])
  expect(
    result.transitions.map((transition) =>
      transition.predecessors.map((entry) => entry.beforeIndex)
    )
  ).toEqual([[0], [1]])
})

it('exposes noise-filtered messages and trailing progress without fabricating intervals', async () => {
  await store([
    at('one', null, '2026-09-26T03:00:00Z'),
    at('two', 'one', '2026-09-26T03:40:00Z', 'system'),
    {
      type: 'progress',
      uuid: 'tail',
      parentUuid: 'two',
      sessionId: 'conversation-a',
      timestamp: '2026-09-26T03:45:00Z',
      data: { type: 'hook_progress' }
    }
  ])
  adoptInitialWorkspacePolicy(db, snapshot)
  const result = resolvedPreview()
  expect(result.before).toHaveLength(1)
  expect(result.before[0].coverage.messages).toHaveLength(1)
  expect(result.unassigned.before.map((event) => event.timestamp).sort()).toEqual([
    '2026-09-26T03:40:00.000Z',
    '2026-09-26T03:45:00.000Z'
  ])
})

it('keeps traces aligned after the detector filters a tiny midnight fragment', async () => {
  const parsed = await store([
    at('one', null, '2026-09-26T03:59:00Z', 'system'),
    at('two', 'one', '2026-09-26T04:00:00Z')
  ])
  adoptInitialWorkspacePolicy(db, snapshot)
  const result = resolvedPreview({ ...policy, reportingTimeZone: 'America/New_York' })
  expect(result.after).toHaveLength(1)
  expect(result.after[0].coverage.messages.map((event) => event.eventId)).toEqual([
    parsed.messages[1].activityIdentity!.eventId
  ])
  expect(result.unassigned.after.map((event) => event.eventId)).toEqual([
    parsed.messages[0].activityIdentity!.eventId
  ])
})

it('does not link unrelated conversations with identical timestamps and measurements', async () => {
  await store(linear())
  await store(
    linear().map((entry) => ({ ...entry, sessionId: 'conversation-b' })),
    'unrelated.jsonl'
  )
  adoptInitialWorkspacePolicy(db, snapshot)
  const [first, second] = previewLedgerWorkspacePolicy(db, policy).conversations
  if (first.status !== 'resolved' || second.status !== 'resolved')
    throw new Error('Expected resolved input')
  expect(first.before[0].startedAt).toBe(second.before[0].startedAt)
  expect(relateCanonicalIntervals(first.before, second.after)).toEqual([
    { afterIndex: 0, predecessors: [] }
  ])
})

it('holds progress attached to an earlier message rather than using it to bridge a later tool', async () => {
  await store([
    ...linear(),
    {
      type: 'progress',
      uuid: 'late-progress',
      parentUuid: 'one',
      sessionId: 'conversation-a',
      timestamp: '2026-09-26T03:54:00Z',
      data: { type: 'bash_progress' }
    }
  ])
  reason('unscoped-progress')
})

it('produces identical ledger previews from independent full-schema databases under three host timezones', async () => {
  const records = linear()
  records[2].timestamp = '2026-09-26T04:05:00Z'
  await store(records)
  const runner = join(directory, 'preview.cjs')
  const bundle = buildSync({
    stdin: {
      resolveDir: process.cwd(),
      contents: `
      const Database = require('better-sqlite3');
      const { drizzle } = require('drizzle-orm/better-sqlite3');
      const { migrate } = require('drizzle-orm/better-sqlite3/migrator');
      const { readFileSync } = require('node:fs');
      const { activityIdentities, activityObservations } = require('./src/main/db/schema/activity-evidence');
      const { appSettings } = require('./src/main/db/schema/app-settings');
      const { adoptInitialWorkspacePolicy, previewLedgerWorkspacePolicy } = require('./src/main/services/workspace-policy');
      const input = JSON.parse(readFileSync(0, 'utf8'));
      const sqlite = new Database(':memory:');
      const db = drizzle(sqlite);
      migrate(db, { migrationsFolder: input.migrationsFolder });
      db.insert(appSettings).values({ key: 'idle_timeout_minutes', value: input.localIdle }).run();
      for (const identity of input.identities) db.insert(activityIdentities).values(identity).run();
      for (const observation of input.observations) db.insert(activityObservations).values(observation).run();
      adoptInitialWorkspacePolicy(db, input.snapshot);
      sqlite.pragma('query_only = ON');
      const preview = previewLedgerWorkspacePolicy(db, input.candidate);
      sqlite.close();
      process.stdout.write(JSON.stringify({ offset: new Date('2026-01-01T00:00:00Z').getTimezoneOffset(), preview }));
    `
    },
    bundle: true,
    platform: 'node',
    format: 'cjs',
    write: false,
    external: ['better-sqlite3']
  })
  writeFileSync(runner, bundle.outputFiles[0].text)
  const identities = db.select().from(activityIdentities).all()
  const observations = db.select().from(activityObservations).all()
  const outcomes = ['UTC', 'America/Los_Angeles', 'Asia/Kathmandu'].map((TZ, index) => {
    const child = spawnSync(process.execPath, [runner], {
      input: JSON.stringify({
        identities: index ? [...identities].reverse() : identities,
        observations: index ? [...observations].reverse() : observations,
        migrationsFolder,
        snapshot,
        localIdle: String(index + 1),
        candidate: { ...policy, reportingTimeZone: 'America/New_York', idleTimeoutMinutes: 5 }
      }),
      encoding: 'utf8',
      timeout: 15000,
      windowsHide: true,
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        TZ,
        NODE_PATH: join(process.cwd(), 'node_modules')
      }
    })
    expect(child.error, child.stderr).toBeUndefined()
    expect(child.status, child.stderr).toBe(0)
    return JSON.parse(child.stdout)
  })
  expect(new Set(outcomes.map((outcome) => outcome.offset)).size).toBe(3)
  expect(outcomes[1].preview).toEqual(outcomes[0].preview)
  expect(outcomes[2].preview).toEqual(outcomes[0].preview)
  expect(outcomes[0].preview.conversations[0]).toMatchObject({
    status: 'resolved',
    before: [{ durationMinutes: 25, promptCount: 2, inputTokens: 100 }],
    after: [{ promptCount: 1 }, { promptCount: 0 }, { promptCount: 1 }]
  })
})

it('keeps Claude ledger coverage at version 1 across continuity and reporting splits', async () => {
  await store([
    at('one', null, '2026-09-26T03:55:00Z'),
    at('two', 'one', '2026-09-26T04:05:00Z', 'assistant')
  ])
  adoptInitialWorkspacePolicy(db, snapshot)
  const preview = resolvedPreview({ ...policy, reportingTimeZone: 'America/New_York' })
  expect(preview.after.some((interval) => interval.coverage.continuity.length)).toBe(true)
  expectVersionOne(preview)
  for (const event of readCanonicalActivity(db).flatMap((entry) =>
    entry.status === 'resolved' ? entry.events : []
  ))
    expect(Object.keys(event)).toEqual(['eventId', 'observationId', 'kind', 'timestamp'])
})

it('retains an earlier event reference only while every observation it cited remains', () => {
  const ref: CanonicalEventReference = {
    eventId: 'event',
    observationId: 'b',
    kind: 'message',
    timestamp: '2026-09-26T03:00:00.000Z'
  }
  const grown = { ...ref, observationId: 'a', observationIds: ['a', 'b'] }
  expect(retainsCanonicalEvent(ref, ref)).toBe(true)
  expect(retainsCanonicalEvent(ref, grown)).toBe(true)
  expect(retainsCanonicalEvent({ ...ref, observationIds: ['b'] }, grown)).toBe(true)
  expect(retainsCanonicalEvent(grown, ref)).toBe(false)
  expect(retainsCanonicalEvent(ref, { ...ref, observationId: 'c' })).toBe(false)
  expect(retainsCanonicalEvent(ref, { ...ref, observationId: 'a', observationIds: ['a'] })).toBe(
    false
  )
  expect(retainsCanonicalEvent(ref, { ...grown, kind: 'progress' })).toBe(false)
  expect(retainsCanonicalEvent(ref, { ...grown, timestamp: '2026-09-26T03:00:01.000Z' })).toBe(
    false
  )
  expect(retainsCanonicalEvent(ref, { ...grown, eventId: 'other' })).toBe(false)
})

const THREAD = '019f7b8d-9ce6-7502-9bc5-014887fbd70e'
const codexAt = (minute: number) =>
  new Date(Date.parse('2026-09-26T03:00:00.000Z') + Math.round(minute * 60_000)).toISOString()
const codexItem = (minute: number, payload: Record<string, unknown>) => ({
  timestamp: codexAt(minute),
  type: 'response_item',
  payload
})
const codexUser = (minute: number, text = 'PRIVATE_TRANSCRIPT') =>
  codexItem(minute, { type: 'message', role: 'user', content: [{ type: 'input_text', text }] })
const codexReply = (minute: number) =>
  codexItem(minute, {
    type: 'message',
    role: 'assistant',
    content: [{ type: 'output_text', text: 'PRIVATE_TRANSCRIPT' }]
  })
const codexTokens = (minute: number, input: number, cached: number, output: number) => ({
  timestamp: codexAt(minute),
  type: 'event_msg',
  payload: {
    type: 'token_count',
    info: {
      total_token_usage: {
        input_tokens: input,
        cached_input_tokens: cached,
        output_tokens: output,
        reasoning_output_tokens: 0,
        total_tokens: input + output
      },
      last_token_usage: {},
      model_context_window: 272000
    }
  }
})
const codexHead = () => [
  {
    timestamp: codexAt(0),
    type: 'session_meta',
    payload: {
      id: THREAD,
      session_id: THREAD,
      cwd: 'C:\\private-project',
      originator: 'codex-tui',
      cli_version: '0.144.6'
    }
  },
  {
    timestamp: codexAt(0),
    type: 'turn_context',
    payload: { cwd: 'C:\\private-project', model: 'model-a' }
  }
]
// A tool call bridged across its gap by the checkpoint written after it.
const codexRollout = () => [
  ...codexHead(),
  codexUser(1),
  codexItem(1.5, { type: 'reasoning', summary: [], encrypted_content: 'PRIVATE_TRANSCRIPT' }),
  codexItem(2, {
    type: 'function_call',
    name: 'shell',
    arguments: '{"command":["ls","C:\\\\private-project"]}',
    call_id: 'call-1'
  }),
  codexTokens(2.1, 100, 20, 10),
  codexItem(20, { type: 'function_call_output', call_id: 'call-1', output: 'PRIVATE_TRANSCRIPT' }),
  codexReply(21),
  codexTokens(21.1, 250, 120, 30)
]
async function storeCodex(lines: unknown[], name = 'rollout.jsonl') {
  const path = join(directory, name)
  writeFileSync(path, lines.map((line) => JSON.stringify(line)).join('\n') + '\n')
  const parsed = (await parseCodexSessionFile(path))!
  expect(parsed.codexActivityEvidence?.status).toBe('captured')
  db.transaction((tx) => storeActivityEvidence(tx, parsed, '2026-09-26T05:00:00Z'))
  return parsed
}
const references = (coverage: CanonicalIntervalCoverage) => [
  ...coverage.messages,
  ...coverage.continuity.flatMap((edge) => [edge.from, edge.to, ...edge.progress])
]
const counts = (intervals: Preview['before']) =>
  intervals.map(({ coverage, ...interval }) => ({
    ...interval,
    messages: coverage.messages.map((event) => event.eventId),
    usage: coverage.usage
  }))
const summary = (interval: Omit<Preview['before'][number], 'coverage'>) => ({
  startedAt: interval.startedAt,
  endedAt: interval.endedAt,
  durationMinutes: interval.durationMinutes,
  promptCount: interval.promptCount,
  inputTokens: interval.inputTokens,
  outputTokens: interval.outputTokens,
  modelUsage: interval.modelUsage
})
/** Every counted token is an exact retained checkpoint observation owned by a counted message. */
function expectBoundUsage(preview: Preview) {
  const observations = new Map(
    db
      .select()
      .from(activityObservations)
      .all()
      .map((entry) => [entry.id, entry])
  )
  for (const interval of [...preview.before, ...preview.after]) {
    expect(Object.keys(interval.coverage)).toEqual(['version', 'messages', 'continuity', 'usage'])
    expect(interval.coverage.version).toBe(2)
    const usage = interval.coverage.usage!
    const owners = new Set(interval.coverage.messages.map((event) => event.eventId))
    for (const entry of usage) {
      expect(entry.messageEventId !== null && owners.has(entry.messageEventId)).toBe(true)
      expect(observations.get(entry.observationId)).toMatchObject({
        eventId: entry.checkpointId,
        kind: 'checkpoint'
      })
    }
    expect(readCanonicalCoverageUsage(JSON.parse(JSON.stringify(usage)))).toEqual(usage)
    expect(usage.reduce((sum, entry) => sum + entry.usage.inputTokens, 0)).toBe(
      interval.inputTokens
    )
    expect(usage.reduce((sum, entry) => sum + entry.usage.outputTokens, 0)).toBe(
      interval.outputTokens
    )
  }
}

it('resolves Codex through the ledger preview with version-2 usage bound to checkpoint observations', async () => {
  const parsed = await storeCodex(codexRollout())
  adoptInitialWorkspacePolicy(db, snapshot)
  const preview = resolvedPreview()
  expect(preview).toMatchObject({ provider: 'codex', conversationId: THREAD })
  expect(preview.before.map(summary)).toEqual(
    detectSessionsWithPolicy([parsed], policy).map(summary)
  )
  expectBoundUsage(preview)
  expect(
    preview.before.flatMap((interval) =>
      interval.coverage.usage!.map((entry) => entry.checkpointId)
    )
  ).toEqual(parsed.codexActivityEvidence!.checkpoints.map((checkpoint) => checkpoint.id))
  expect(preview.unassignedUsage).toEqual({ before: [], after: [] })
  expect(Object.keys(preview.unassigned)).toEqual(['before', 'after'])
  expect(JSON.stringify(preview)).not.toMatch(/PRIVATE_TRANSCRIPT|private-project|rollout\.jsonl/)
})

it('converges Codex counts across live growth and a copy while earlier anchors stay retained', async () => {
  const lines = codexRollout()
  await storeCodex(lines.slice(0, 5), 'live.jsonl')
  adoptInitialWorkspacePolicy(db, snapshot)
  const early = resolvedPreview()
  // No checkpoint yet: version 2 still carries its (empty) usage list.
  expect(early.before.length).toBeGreaterThan(0)
  for (const interval of early.before)
    expect(interval.coverage).toMatchObject({ version: 2, usage: [] })
  await storeCodex(lines.slice(0, 6), 'live.jsonl')
  const partial = resolvedPreview()
  await storeCodex(lines.slice(0, 8), 'live.jsonl')
  const parsed = await storeCodex(lines, 'live.jsonl')
  deviceId = '7c8f7eab-af58-4cbb-9e74-d1e47f80d600'
  await storeCodex(lines, 'copy.jsonl')
  const grown = resolvedPreview()
  expectBoundUsage(grown)

  const current = new Map(
    [
      ...grown.before.flatMap((interval) => references(interval.coverage)),
      ...grown.unassigned.before
    ].map((event) => [event.eventId, event])
  )
  const anchors = [...early.before, ...partial.before].flatMap((interval) =>
    references(interval.coverage)
  )
  for (const anchor of anchors)
    expect(retainsCanonicalEvent(anchor, current.get(anchor.eventId)!)).toBe(true)
  // The tool call gained a compatible usage observation. Earlier anchors cite a subset.
  const call = parsed.messages[1].activityIdentity!.eventId
  const earlyCall = early.before
    .flatMap((interval) => interval.coverage.messages)
    .find((event) => event.eventId === call)!
  expect(earlyCall.observationIds).toHaveLength(1)
  expect(current.get(call)!.observationIds).toHaveLength(2)
  expect(retainsCanonicalEvent(current.get(call)!, earlyCall)).toBe(false)
  // Usage counted earlier is still the same checkpoint observation and owner.
  const partialUsage = partial.before.flatMap((interval) => interval.coverage.usage!)
  expect(partialUsage.length).toBeGreaterThan(0)
  const grownUsage = grown.before.flatMap((interval) => interval.coverage.usage!)
  for (const entry of partialUsage) expect(grownUsage).toContainEqual(entry)

  // The same counts as a database that only ever saw the complete file.
  sqlite.close()
  sqlite = new Database(':memory:')
  sqlite.pragma('foreign_keys = ON')
  db = drizzle(sqlite)
  migrate(db, { migrationsFolder })
  await storeCodex(lines, 'only.jsonl')
  adoptInitialWorkspacePolicy(db, snapshot)
  const clean = resolvedPreview()
  expect(counts(grown.before)).toEqual(counts(clean.before))
  expect(counts(grown.after)).toEqual(counts(clean.after))
  expect(grown.unassignedUsage).toEqual(clean.unassignedUsage)
})

it('reports Codex usage no interval counts and moves it into counts once its owner is recorded', async () => {
  const head = [...codexHead(), codexUser(1), codexTokens(1.1, 40, 0, 0)]
  const pending = await storeCodex(head, 'live.jsonl')
  adoptInitialWorkspacePolicy(db, snapshot)
  const waiting = resolvedPreview()
  expect(waiting.before.length).toBeGreaterThan(0)
  for (const interval of waiting.before)
    expect(interval.coverage).toMatchObject({ version: 2, usage: [] })
  expect(waiting.unassignedUsage!.before).toMatchObject([
    {
      checkpointId: pending.codexActivityEvidence!.checkpoints[0].id,
      messageEventId: null,
      usage: { inputTokens: 40 }
    }
  ])
  expect(waiting.unassignedUsage!.after).toEqual(waiting.unassignedUsage!.before)
  // Counted plus separately reported usage is the whole recorded total.
  expect(
    waiting.before.reduce((sum, interval) => sum + interval.inputTokens, 0) +
      waiting.unassignedUsage!.before.reduce((sum, entry) => sum + entry.usage.inputTokens, 0)
  ).toBe(pending.totalTokenUsage.inputTokens)

  const parsed = await storeCodex(
    [...head, codexReply(2), codexTokens(2.1, 100, 0, 10)],
    'live.jsonl'
  )
  const owned = resolvedPreview()
  expectBoundUsage(owned)
  expect(owned.unassignedUsage).toEqual({ before: [], after: [] })
  const counted = owned.before.flatMap((interval) => interval.coverage.usage!)
  expect(counted.map((entry) => entry.checkpointId)).toEqual(
    parsed.codexActivityEvidence!.checkpoints.map((checkpoint) => checkpoint.id)
  )
  expect(new Set(counted.map((entry) => entry.messageEventId))).toEqual(
    new Set([parsed.messages[1].activityIdentity!.eventId])
  )
  expect(owned.before.reduce((sum, interval) => sum + interval.inputTokens, 0)).toBe(
    parsed.totalTokenUsage.inputTokens
  )
})

it.each([
  [
    'a corrected checkpoint',
    { reason: 'unresolved-checkpoint', checkpoint: { reason: 'conflicting-observations' } },
    [codexRollout(), [...codexRollout().slice(0, 8), codexTokens(21.1, 260, 120, 30)]]
  ],
  [
    'divergent activity after a shared prefix',
    { reason: 'branching-activity' },
    [
      [...codexRollout().slice(0, 6), codexUser(30, 'first branch')],
      [...codexRollout().slice(0, 6), codexUser(30, 'second branch')]
    ]
  ]
])(
  'holds Codex %s through the canonical path and the ledger preview',
  async (_label, held, files) => {
    for (const [index, lines] of files.entries()) await storeCodex(lines, `rollout-${index}.jsonl`)
    expect(readCanonicalActivity(db)).toEqual([
      expect.objectContaining({ provider: 'codex', conversationId: THREAD, status: 'unresolved' })
    ])
    expect(readCanonicalActivity(db)[0]).toMatchObject(held)
    adoptInitialWorkspacePolicy(db, snapshot)
    const [conversation] = previewLedgerWorkspacePolicy(db, policy).conversations
    expect(conversation).toMatchObject({ status: 'unresolved', ...held })
    expect(conversation).not.toHaveProperty('before')
    expect(conversation).not.toHaveProperty('unassignedUsage')
  }
)

it('previews an explicit normalization change with each side read under its own recorded version', async () => {
  // Resumed after idle: the new turn checkpoints usage before its reply.
  const parsed = await storeCodex([
    ...codexHead(),
    codexUser(1),
    codexReply(2),
    codexTokens(2.1, 100, 20, 10),
    codexUser(42),
    codexTokens(42.6, 250, 120, 30),
    codexReply(43),
    codexTokens(43.1, 300, 150, 40)
  ])
  // An existing version-1 workspace is not changed by the new default.
  adoptInitialWorkspacePolicy(db, snapshot)
  const unchanged = resolvedPreview()
  const tokens = (intervals: Preview['before']) =>
    intervals.map((interval) => [interval.inputTokens, interval.outputTokens])
  expect(tokens(unchanged.before)).toEqual([
    [130, 30],
    [20, 10]
  ])
  expect(unchanged.after).toEqual(unchanged.before)

  const converted = resolvedPreview({ ...policy, normalizationVersion: 2 })
  expectBoundUsage(converted)
  expect(converted.before).toEqual(unchanged.before)
  expect(tokens(converted.after)).toEqual([
    [80, 10],
    [70, 30]
  ])
  // Only checkpoint ownership moves: same times, prompts, events and conversation total.
  const times = (intervals: Preview['before']) =>
    intervals.map((interval) => [interval.startedAt, interval.endedAt, interval.promptCount])
  expect(times(converted.after)).toEqual(times(converted.before))
  expect(
    converted.transitions.map((row) => row.predecessors.map((entry) => entry.beforeIndex))
  ).toEqual([[0], [1]])
  const total = (intervals: Preview['before']) =>
    intervals.reduce((sum, interval) => sum + interval.inputTokens, 0)
  expect(total(converted.after)).toBe(parsed.totalTokenUsage.inputTokens)
  expect(total(converted.before)).toBe(parsed.totalTokenUsage.inputTokens)
  expect(converted.unassignedUsage).toEqual({ before: [], after: [] })
})
