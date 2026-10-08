// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { activityIdentities, activityObservations } from '../db/schema/activity-evidence'
import { parseCodexSessionFile } from '../parsers/codex-parser'
import type { ParsedSessionData } from '../parsers/types'
import { storeActivityEvidence } from './activity-evidence'
import { readCanonicalActivity } from './canonical-activity'
import {
  calculateCanonicalIntervals,
  constrainCanonicalIntervals,
  partitionCanonicalInterval
} from './canonical-intervals'
import {
  codexCoverageUsage,
  readCanonicalCodexActivity,
  readCanonicalCoverageUsage
} from './canonical-codex'
import type { CodexCheckpointDelta } from './codex-checkpoint-deltas'
import { detectSessionsWithPolicy } from './session-detector'

vi.mock('electron-log/main.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
}))
let deviceId = '9b95ec41-b3b6-4cbb-b1b6-e7ce607ef222'
vi.mock('./device-context', () => ({
  getLocalDeviceSession: () => ({ deviceId, machineName: 'Fixture machine' })
}))
// Simulates the delta reader's separate statement seeing different evidence.
let tamper: ((delta: CodexCheckpointDelta) => CodexCheckpointDelta) | null = null
vi.mock('./codex-checkpoint-deltas', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./codex-checkpoint-deltas')>()
  return {
    ...actual,
    readCodexCheckpointDeltas: (db: Parameters<typeof actual.readCodexCheckpointDeltas>[0]) =>
      actual.readCodexCheckpointDeltas(db).map((delta) => (tamper ? tamper(delta) : delta))
  }
})

type Line = Record<string, unknown>
type Db = ReturnType<typeof drizzle>
const THREAD = '019f7b8d-9ce6-7502-9bc5-014887fbd70e'
const OTHER_THREAD = '019f7b8d-0000-7000-8000-000000000000'
const migrationsFolder = join(__dirname, '../db/migrations')
const policy = {
  version: 1,
  normalizationVersion: 1,
  detectorVersion: 1,
  idleTimeoutMinutes: 15,
  reportingTimeZone: 'UTC'
}
const opened: Database.Database[] = []
let sqlite: Database.Database
let db: Db
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
  directory = mkdtempSync(join(tmpdir(), 'clautime-codex-canonical-'))
  const created = database()
  sqlite = created.connection
  db = created.target
  deviceId = '9b95ec41-b3b6-4cbb-b1b6-e7ce607ef222'
  tamper = null
})
afterEach(() => {
  for (const connection of opened.splice(0)) connection.close()
  const target = resolve(directory)
  if (!target.startsWith(resolve(tmpdir()) + sep) || !target.includes('clautime-codex-canonical-'))
    throw new Error('Unexpected fixture directory')
  rmSync(target, { recursive: true, force: true })
})

const time = (minute: number) =>
  new Date(Date.parse('2026-09-26T03:00:00.000Z') + Math.round(minute * 60_000)).toISOString()
const item = (minute: number, payload: Line): Line => ({
  timestamp: time(minute),
  type: 'response_item',
  payload
})
const meta = (id = THREAD): Line => ({
  timestamp: time(0),
  type: 'session_meta',
  payload: {
    id,
    session_id: id,
    cwd: 'C:\\private-project',
    originator: 'codex-tui',
    cli_version: '0.144.6'
  }
})
const turn = (minute: number, model: string): Line => ({
  timestamp: time(minute),
  type: 'turn_context',
  payload: { cwd: 'C:\\private-project', model }
})
const user = (minute: number, text = 'PRIVATE_TRANSCRIPT') =>
  item(minute, { type: 'message', role: 'user', content: [{ type: 'input_text', text }] })
const assistant = (minute: number, extra: Line = {}) =>
  item(minute, {
    type: 'message',
    role: 'assistant',
    content: [{ type: 'output_text', text: 'PRIVATE_TRANSCRIPT' }],
    ...extra
  })
const call = (minute: number, extra: Line = {}) =>
  item(minute, {
    type: 'function_call',
    name: 'shell',
    arguments: '{"command":["ls","C:\\\\private-project"]}',
    call_id: 'call-1',
    ...extra
  })
const output = (minute: number) =>
  item(minute, { type: 'function_call_output', call_id: 'call-1', output: 'PRIVATE_TRANSCRIPT' })
const reasoning = (minute: number) =>
  item(minute, { type: 'reasoning', summary: [], encrypted_content: 'PRIVATE_TRANSCRIPT' })
const compacted = (minute: number): Line => ({
  timestamp: time(minute),
  type: 'compacted',
  payload: { message: 'PRIVATE_TRANSCRIPT' }
})
const note = (minute: number): Line => ({
  timestamp: time(minute),
  type: 'event_msg',
  payload: { type: 'agent_reasoning', text: 'PRIVATE_TRANSCRIPT' }
})
const tokens = (minute: number, input: number, cached: number, out: number): Line => ({
  timestamp: time(minute),
  type: 'event_msg',
  payload: {
    type: 'token_count',
    info: {
      total_token_usage: {
        input_tokens: input,
        cached_input_tokens: cached,
        output_tokens: out,
        reasoning_output_tokens: 0,
        total_tokens: input + out
      },
      last_token_usage: {},
      model_context_window: 272000
    }
  }
})
// A tool call bridged across an 18-minute gap by the checkpoint written after it.
const conversation = (): Line[] => [
  meta(),
  turn(0, 'model-a'),
  user(1),
  reasoning(1.5),
  call(2),
  tokens(2.1, 100, 20, 10),
  output(20),
  assistant(21),
  tokens(21.1, 250, 120, 30)
]

async function store(lines: Line[], name = 'rollout.jsonl', target = db) {
  const path = join(directory, name)
  writeFileSync(path, lines.map((line) => JSON.stringify(line)).join('\n') + '\n')
  const parsed = (await parseCodexSessionFile(path))!
  expect(parsed.codexActivityEvidence?.status).toBe('captured')
  target.transaction((tx) => storeActivityEvidence(tx, parsed, '2026-09-26T05:00:00Z'))
  return parsed
}
function resolved(target = db) {
  const result = readCanonicalCodexActivity(target)
  expect(result).toHaveLength(1)
  if (result[0].status !== 'resolved')
    throw new Error(`Expected resolved Codex history, got ${result[0].reason}`)
  return result[0]
}
function held(reason: string, target = db) {
  const result = readCanonicalCodexActivity(target)
  expect(result).toEqual([
    expect.objectContaining({
      provider: 'codex',
      conversationId: THREAD,
      status: 'unresolved',
      reason
    })
  ])
  return result[0]
}
const messageIds = (parsed: ParsedSessionData) =>
  parsed.messages.map((message) => message.activityIdentity!.eventId)
type Summary = {
  startedAt: string
  endedAt: string
  durationMinutes: number
  promptCount: number
  inputTokens: number
  outputTokens: number
  modelUsage: unknown
}
const summary = (interval: Summary): Summary => ({
  startedAt: interval.startedAt,
  endedAt: interval.endedAt,
  durationMinutes: interval.durationMinutes,
  promptCount: interval.promptCount,
  inputTokens: interval.inputTokens,
  outputTokens: interval.outputTokens,
  modelUsage: interval.modelUsage
})
function expectParserIntervals(
  parsed: ParsedSessionData,
  conversation: ReturnType<typeof resolved>
) {
  const canonical = calculateCanonicalIntervals(conversation, policy).map(summary)
  expect(canonical.length).toBeGreaterThan(0)
  expect(canonical).toEqual(detectSessionsWithPolicy([parsed], policy).map(summary))
}
function rewrite(eventId: string, change: (payload: Record<string, unknown>) => void) {
  const observation = db
    .select()
    .from(activityObservations)
    .all()
    .find((entry) => entry.eventId === eventId)!
  const payload = JSON.parse(observation.payloadJson)
  change(payload)
  sqlite
    .prepare('UPDATE activity_observations SET payload_json = ? WHERE id = ?')
    .run(JSON.stringify(payload), observation.id)
}

it('resolves a linear rollout to the parser intervals and binds every count to exact observations', async () => {
  const parsed = await store(conversation())
  const result = resolved()
  expectParserIntervals(parsed, result)
  const ids = messageIds(parsed)
  const projected = result.recording.messages.map((entry) => [entry.uuid, entry.type, entry.usage])
  expect(projected).toEqual([
    [ids[0], 'user', null],
    [
      ids[1],
      'assistant',
      { inputTokens: 80, outputTokens: 10, cacheCreationInputTokens: 0, cacheReadInputTokens: 20 }
    ],
    [ids[2], 'user', null],
    [
      ids[3],
      'assistant',
      { inputTokens: 50, outputTokens: 20, cacheCreationInputTokens: 0, cacheReadInputTokens: 100 }
    ]
  ])
  expect(result.recording.totalTokenUsage).toEqual(parsed.totalTokenUsage)
  expect(result.recording.progressTimestamps).toEqual(parsed.progressTimestamps)

  const observations = new Map(
    db
      .select()
      .from(activityObservations)
      .all()
      .map((entry) => [entry.id, entry])
  )
  for (const event of result.events) {
    expect(event.observationIds).toContain(event.observationId)
    for (const id of event.observationIds) expect(observations.get(id)?.eventId).toBe(event.eventId)
  }
  const [interval, ...rest] = calculateCanonicalIntervals(result, policy)
  expect(rest).toEqual([])
  const usage = codexCoverageUsage(result, interval.coverage)
  expect(interval.coverage).toMatchObject({ version: 2, usage })
  expect(readCanonicalCoverageUsage(JSON.parse(JSON.stringify(interval.coverage.usage)))).toEqual(
    usage
  )
  expect(usage.map((entry) => entry.messageEventId)).toEqual([ids[1], ids[3]])
  expect(usage.map((entry) => entry.checkpointId)).toEqual(
    parsed.codexActivityEvidence!.checkpoints.map((checkpoint) => checkpoint.id)
  )
  for (const entry of usage)
    expect(observations.get(entry.observationId)).toMatchObject({
      eventId: entry.checkpointId,
      kind: 'checkpoint'
    })
  expect(usage.map((entry) => entry.delta)).toEqual([
    {
      input_tokens: 100,
      cached_input_tokens: 20,
      output_tokens: 10,
      reasoning_output_tokens: 0,
      total_tokens: 110
    },
    {
      input_tokens: 150,
      cached_input_tokens: 100,
      output_tokens: 20,
      reasoning_output_tokens: 0,
      total_tokens: 170
    }
  ])
  expect(usage.reduce((sum, entry) => sum + entry.usage.inputTokens, 0)).toBe(interval.inputTokens)
  expect(usage.reduce((sum, entry) => sum + entry.usage.outputTokens, 0)).toBe(
    interval.outputTokens
  )
  const toolGap = interval.coverage.continuity.find((edge) => edge.from.eventId === ids[1])!
  expect(toolGap.to.eventId).toBe(ids[2])
  expect(toolGap.progress.map((event) => event.eventId)).toEqual([usage[0].checkpointId])
  // Portable identities only: no transcript, path, source file or parser line number.
  expect(JSON.stringify(result)).not.toMatch(
    /PRIVATE_TRANSCRIPT|private-project|rollout\.jsonl|"l\d+"/
  )
})

it('deduplicates growing and copied rollouts without double counting the parser running usage', async () => {
  const lines = conversation()
  await store(lines.slice(0, 5), 'live.jsonl')
  await store(lines.slice(0, 6), 'live.jsonl')
  await store(lines.slice(0, 8), 'live.jsonl')
  const parsed = await store(lines, 'live.jsonl')
  deviceId = '7c8f7eab-af58-4cbb-9e74-d1e47f80d600'
  await store(lines, 'copy.jsonl')
  const result = resolved()
  const ids = messageIds(parsed)
  // Tool call: usage absent, then complete. Final reply: absent, then complete.
  for (const id of [ids[1], ids[3]]) {
    const event = result.events.find((entry) => entry.eventId === id)!
    expect(event.observationIds).toHaveLength(2)
    expect(event.observationId).toBe([...event.observationIds].sort()[0])
  }
  expectParserIntervals(parsed, result)

  const clean = database()
  await store(lines, 'only.jsonl', clean.target)
  const expected = resolved(clean.target)
  expect(result.recording).toEqual(expected.recording)
  expect(result.usage).toEqual(expected.usage)
  expect(result.events.map((event) => [event.eventId, event.kind, event.timestamp])).toEqual(
    expected.events.map((event) => [event.eventId, event.kind, event.timestamp])
  )
  const strip = (intervals: ReturnType<typeof calculateCanonicalIntervals>) =>
    intervals.map(({ coverage, ...interval }) => ({
      ...interval,
      messages: coverage.messages.map((event) => event.eventId),
      progress: coverage.continuity.flatMap((edge) => edge.progress.map((event) => event.eventId))
    }))
  expect(strip(calculateCanonicalIntervals(result, policy))).toEqual(
    strip(calculateCanonicalIntervals(expected, policy))
  )
  const copy = new Database(sqlite.serialize())
  opened.push(copy)
  expect(readCanonicalCodexActivity(drizzle(copy))).toEqual(readCanonicalCodexActivity(db))
})

it('attributes usage across a model switch to the model recorded with each checkpoint', async () => {
  const parsed = await store([
    meta(),
    turn(0, 'model-a'),
    user(1),
    assistant(2),
    tokens(2.1, 100, 0, 10),
    turn(3, 'model-b'),
    user(3.5),
    assistant(4),
    tokens(4.1, 300, 50, 30)
  ])
  const result = resolved()
  expectParserIntervals(parsed, result)
  expect(result.usage.map((entry) => entry.model)).toEqual(['model-a', 'model-b'])
  expect(result.recording.models).toEqual(['model-a', 'model-b'])
  expect(calculateCanonicalIntervals(result, policy)[0].modelUsage).toEqual([
    {
      model: 'model-a',
      inputTokens: 100,
      outputTokens: 10,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0
    },
    {
      model: 'model-b',
      inputTokens: 150,
      outputTokens: 20,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 50
    }
  ])
})

it('carries usage recorded before any assistant to the next one and never invents an owner', async () => {
  const parsed = await store([
    meta(),
    turn(0, 'model-a'),
    tokens(0.5, 10, 0, 0),
    user(1),
    reasoning(1.2),
    tokens(1.3, 40, 0, 0),
    call(2),
    tokens(2.1, 100, 0, 10),
    output(3),
    assistant(4)
  ])
  const result = resolved()
  expectParserIntervals(parsed, result)
  const ids = messageIds(parsed)
  expect(result.usage.map((entry) => entry.messageEventId)).toEqual([ids[1], ids[1], ids[1]])
  expect(result.recording.messages[1].usage).toEqual({
    inputTokens: 100,
    outputTokens: 10,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0
  })

  const waiting = database()
  const pending = await store(
    [meta(), turn(0, 'model-a'), user(1), tokens(1.1, 40, 0, 0)],
    'waiting.jsonl',
    waiting.target
  )
  const unowned = resolved(waiting.target)
  expect(unowned.usage).toMatchObject([{ messageEventId: null, usage: { inputTokens: 40 } }])
  expect(unowned.recording.totalTokenUsage).toEqual(pending.totalTokenUsage)
  const [interval] = calculateCanonicalIntervals(unowned, policy)
  expect(codexCoverageUsage(unowned, interval.coverage)).toEqual([])
  // Version 2 always carries its usage list, even when no checkpoint is counted.
  expect(interval.coverage).toMatchObject({ version: 2, usage: [] })
  expectParserIntervals(pending, unowned)
})

// Resumed after 40 idle minutes: the new turn writes a checkpoint before its reply.
const resumed = (): Line[] => [
  meta(),
  turn(0, 'model-a'),
  user(1),
  reasoning(1.5),
  assistant(2),
  tokens(2.1, 100, 20, 10),
  user(42),
  reasoning(42.5),
  tokens(42.6, 250, 120, 30),
  assistant(43),
  tokens(43.1, 300, 150, 40)
]
const ownedBy = (conversation: ReturnType<typeof resolved>) =>
  conversation.usage.map((entry) => [entry.checkpointId, entry.messageEventId])

it('versions checkpoint ownership so a resumed turn owns the usage written before its reply', async () => {
  const parsed = await store(resumed())
  const ids = messageIds(parsed)
  const assistants = parsed.messages.flatMap((message, index) =>
    message.type === 'assistant' ? [ids[index]] : []
  )
  const v1 = resolved()
  const [v2] = readCanonicalCodexActivity(db, undefined, { checkpointOwnership: 2 })
  if (v2.status !== 'resolved') throw new Error(`Expected resolved Codex history, got ${v2.reason}`)
  // Ownership 1 stays the parser's, so recorded intervals and coverage are unchanged.
  expectParserIntervals(parsed, v1)
  const checkpoints = v1.usage.map((entry) => entry.checkpointId)
  expect(ownedBy(v1)).toEqual([
    [checkpoints[0], assistants[0]],
    [checkpoints[1], assistants[0]],
    [checkpoints[2], assistants[1]]
  ])
  expect(ownedBy(v2)).toEqual([
    [checkpoints[0], assistants[0]],
    [checkpoints[1], assistants[1]],
    [checkpoints[2], assistants[1]]
  ])
  // Same event and checkpoint IDs, same conversation total; only the owner moves.
  expect(v2.eventIds).toEqual(v1.eventIds)
  expect(v2.events).toEqual(v1.events)
  expect(v2.recording.totalTokenUsage).toEqual(parsed.totalTokenUsage)
  expect(
    v2.recording.messages
      .filter((message) => message.type === 'assistant')
      .map((message) => message.usage)
  ).toEqual([
    { inputTokens: 80, outputTokens: 10, cacheCreationInputTokens: 0, cacheReadInputTokens: 20 },
    { inputTokens: 70, outputTokens: 30, cacheCreationInputTokens: 0, cacheReadInputTokens: 130 }
  ])
  const intervals = calculateCanonicalIntervals(v2, policy)
  // Ownership never moves time: the idle gap splits both the same way.
  const times = (list: typeof intervals) =>
    list.map((interval) => [
      interval.startedAt,
      interval.endedAt,
      interval.durationMinutes,
      interval.promptCount
    ])
  expect(intervals).toHaveLength(2)
  expect(times(intervals)).toEqual(times(calculateCanonicalIntervals(v1, policy)))
  expect(intervals[0].startedAt).toBe(time(1))
  expect(intervals[1].startedAt).toBe(time(42))
  expect(
    intervals.map((interval) => interval.coverage.usage!.map((entry) => entry.checkpointId))
  ).toEqual([[checkpoints[0]], [checkpoints[1], checkpoints[2]]])

  // Before the reply is recorded the resumed usage has no owner; none is invented.
  const waiting = database()
  await store(resumed().slice(0, 9), 'waiting.jsonl', waiting.target)
  const [pending] = readCanonicalCodexActivity(waiting.target, undefined, {
    checkpointOwnership: 2
  })
  if (pending.status !== 'resolved') throw new Error('Expected resolved Codex history')
  expect(pending.usage.map((entry) => entry.messageEventId)).toEqual([assistants[0], null])
  const [first] = calculateCanonicalIntervals(pending, policy)
  expect(first.coverage.usage!.map((entry) => entry.checkpointId)).toEqual([checkpoints[0]])
})

const policyV2 = { ...policy, normalizationVersion: 2 }
function normalized(version: 1 | 2) {
  const [conversation] = readCanonicalActivity(db, undefined, { normalizationVersion: version })
  if (conversation?.status !== 'resolved') throw new Error('Expected resolved Codex history')
  return conversation
}
const tokenCounts = (list: ReturnType<typeof calculateCanonicalIntervals>) =>
  list.map((interval) => [interval.inputTokens, interval.outputTokens])

it('projects the policy normalization version through the canonical reader', async () => {
  await store(resumed())
  const v1 = normalized(1)
  const v2 = normalized(2)
  // The default stays version 1 so every recorded mapping and coverage still reproduces.
  expect(readCanonicalActivity(db)).toEqual([v1])
  expect(v1.usage).toEqual(resolved().usage)
  const [direct] = readCanonicalCodexActivity(db, undefined, { checkpointOwnership: 2 })
  expect(v2).toEqual(direct)
  expect(tokenCounts(calculateCanonicalIntervals(v1, policy))).toEqual([
    [130, 30],
    [20, 10]
  ])
  expect(tokenCounts(calculateCanonicalIntervals(v2, policyV2))).toEqual([
    [80, 10],
    [70, 30]
  ])
})

it('keeps a resumed continuation whole under version 2 when the earlier segment is deleted', async () => {
  await store(resumed())
  const v1 = normalized(1)
  const v2 = normalized(2)
  const [earlierV1] = calculateCanonicalIntervals(v1, policy)
  const [earlierV2, continuation] = calculateCanonicalIntervals(v2, policyV2)
  const constraints = (coverage: typeof earlierV2.coverage) => ({
    cuts: [],
    masks: [{ sessionId: 1, coverage }],
    invalid: []
  })

  const kept = constrainCanonicalIntervals(
    v2,
    calculateCanonicalIntervals(v2, policyV2),
    constraints(earlierV2.coverage)
  )
  expect(kept.invalid).toEqual([])
  expect(kept.conflicts).toEqual([])
  expect(kept.suppressed.map((row) => row.interval)).toEqual([earlierV2])
  // The resumed checkpoint written before its reply is not dropped with the earlier segment.
  expect(kept.intervals).toEqual([continuation])
  expect(tokenCounts(kept.intervals)).toEqual([[70, 30]])

  // Version 1 (unchanged): the same deletion removes the resumed turn's pre-reply usage.
  const legacy = constrainCanonicalIntervals(
    v1,
    calculateCanonicalIntervals(v1, policy),
    constraints(earlierV1.coverage)
  )
  expect(tokenCounts(legacy.intervals)).toEqual([[20, 10]])

  // A version-1 deletion read under version 2 is held as changed evidence, never re-counted.
  const converted = constrainCanonicalIntervals(
    v2,
    calculateCanonicalIntervals(v2, policyV2),
    constraints(earlierV1.coverage)
  )
  expect(converted.invalid).toEqual([{ sessionId: 1, reason: 'changed-deleted-evidence' }])
})

it('splits a version 2 continuation with pre-reply usage staying with its reply', async () => {
  await store(resumed())
  const v2 = normalized(2)
  const [, continuation] = calculateCanonicalIntervals(v2, policyV2)
  const cut = time(42.8)
  const parts = constrainCanonicalIntervals(v2, [continuation], {
    cuts: [cut],
    masks: [],
    invalid: []
  }).intervals
  expect(parts.map((part) => [part.startedAt, part.endedAt])).toEqual([
    [time(42), cut],
    [cut, time(43)]
  ])
  expect(tokenCounts(parts)).toEqual([
    [0, 0],
    [70, 30]
  ])
  expect(parts.map((part) => part.coverage.usage!.length)).toEqual([0, 2])
  expect(partitionCanonicalInterval(v2, continuation, [cut])).toEqual(parts)
})

it('keeps compaction as ancestry only and never counts it as progress', async () => {
  const parsed = await store([
    meta(),
    turn(0, 'model-a'),
    user(1),
    call(2),
    tokens(2.1, 100, 0, 10),
    compacted(3),
    output(20),
    assistant(21)
  ])
  const result = resolved()
  expectParserIntervals(parsed, result)
  const marker = parsed.codexActivityEvidence!.activities.find(
    (activity) => activity.kind === 'compacted'
  )!.identity.eventId
  expect(result.eventIds).toContain(marker)
  expect(result.events.map((event) => event.eventId)).not.toContain(marker)
  expect(result.recording.progressTimestamps).not.toContain(time(3))
})

const event = (minute: number, type: string, extra: Line = {}): Line => ({
  timestamp: time(minute),
  type: 'event_msg',
  payload: { type, ...extra }
})
const emptyTokens = (minute: number) => event(minute, 'token_count', { info: null })
// A 38-minute tool call kept alive only by event_msg and empty token_count progress,
// with lifecycle progress before any activity and before any assistant record.
const longTool = (): Line[] => [
  meta(),
  turn(0, 'model-a'),
  event(0.5, 'task_started'),
  user(1),
  note(1.5),
  call(2),
  event(5, 'exec_command_begin', { call_id: 'call-1', command: ['PRIVATE_TRANSCRIPT'] }),
  emptyTokens(15),
  note(30),
  output(40),
  assistant(41),
  tokens(41.1, 1000, 0, 100),
  event(41.2, 'task_complete')
]
const withoutProgress = (lines: Line[]) =>
  lines.filter((line) => line.type !== 'event_msg' || (line.payload as Line).info != null)
const progressIds = (parsed: ParsedSessionData) =>
  parsed.codexActivityEvidence!.progress.map((progress) => progress.eventId)

it('bridges a long tool gap with event and empty token_count progress exactly as the parser does', async () => {
  const lines = longTool()
  const parsed = await store(lines)
  const result = resolved()
  expectParserIntervals(parsed, result)
  expect(result.recording.progressTimestamps).toEqual(parsed.progressTimestamps)
  const [interval, ...rest] = calculateCanonicalIntervals(result, policy)
  expect(rest).toEqual([])
  expect(detectSessionsWithPolicy([parsed], policy)).toHaveLength(1)
  const ids = messageIds(parsed)
  const toolGap = interval.coverage.continuity.find((edge) => edge.from.eventId === ids[1])!
  expect(toolGap.to.eventId).toBe(ids[2])
  expect(toolGap.progress.map((entry) => entry.eventId)).toEqual(
    parsed
      .codexActivityEvidence!.progress.filter(
        (progress) => progress.timestamp > time(2) && progress.timestamp < time(40)
      )
      .map((progress) => progress.eventId)
  )
  // The totals-bearing checkpoint stays the only progress at its instant.
  expect(result.recording.progressTimestamps.filter((at) => at === time(41.1))).toHaveLength(1)
  expect(result.usage.map((entry) => entry.messageEventId)).toEqual([ids[3]])
  const stored = JSON.stringify(db.select().from(activityObservations).all())
  expect(stored).not.toMatch(/PRIVATE_TRANSCRIPT|private-project|call-1/)
  expect(JSON.stringify(result)).not.toMatch(/PRIVATE_TRANSCRIPT|private-project|rollout\.jsonl/)

  // Without the progress lines the parser and the ledger both split, and every
  // message, activity and checkpoint identity is byte-identical to the file above.
  const other = database()
  const plain = await store(withoutProgress(lines), 'plain.jsonl', other.target)
  const plainResult = resolved(other.target)
  expectParserIntervals(plain, plainResult)
  expect(calculateCanonicalIntervals(plainResult, policy)).toHaveLength(2)
  expect(plain.messages.map((message) => message.activityIdentity)).toEqual(
    parsed.messages.map((message) => message.activityIdentity)
  )
  expect(plain.codexActivityEvidence!.activities).toEqual(parsed.codexActivityEvidence!.activities)
  expect(plain.codexActivityEvidence!.checkpoints).toEqual(
    parsed.codexActivityEvidence!.checkpoints
  )
  expect(plain.codexActivityEvidence!.progress).toEqual([])
})

it('deduplicates progress leaves across growth and copies and matches a clean database', async () => {
  const lines = longTool()
  await store(lines.slice(0, 7), 'live.jsonl')
  await store(lines.slice(0, 9), 'live.jsonl')
  const parsed = await store(lines, 'live.jsonl')
  deviceId = '7c8f7eab-af58-4cbb-9e74-d1e47f80d600'
  await store(lines, 'copy.jsonl')
  const result = resolved()
  expectParserIntervals(parsed, result)
  expect(
    db
      .select()
      .from(activityIdentities)
      .all()
      .filter((identity) => identity.basis === 'progress')
      .map((identity) => identity.eventId)
      .sort()
  ).toEqual([...progressIds(parsed)].sort())
  for (const id of progressIds(parsed)) {
    const entry = result.events.find((candidate) => candidate.eventId === id)!
    expect(entry).toMatchObject({ kind: 'progress' })
    expect(entry.observationIds).toEqual([entry.observationId])
  }

  const clean = database()
  await store(lines, 'only.jsonl', clean.target)
  const expected = resolved(clean.target)
  expect(result.recording).toEqual(expected.recording)
  expect(result.events.map((entry) => [entry.eventId, entry.kind, entry.timestamp])).toEqual(
    expected.events.map((entry) => [entry.eventId, entry.kind, entry.timestamp])
  )
  // Progress is listed by instant.
  const progress = result.events.filter((entry) => entry.kind === 'progress')
  expect(progress.map((entry) => entry.timestamp)).toEqual(
    progress.map((entry) => entry.timestamp).sort()
  )
})

it('reads a ledger captured before progress evidence and adds progress without new identities for old facts', async () => {
  const lines = longTool()
  const path = join(directory, 'earlier.jsonl')
  writeFileSync(path, lines.map((line) => JSON.stringify(line)).join('\n') + '\n')
  const parsed = (await parseCodexSessionFile(path))!
  // What the previous capture stored for this same file: no progress leaves.
  const earlier: ParsedSessionData = {
    ...parsed,
    codexActivityEvidence: { ...parsed.codexActivityEvidence!, progress: [] }
  }
  db.transaction((tx) => storeActivityEvidence(tx, earlier, '2026-09-26T05:00:00Z'))
  const before = db.select().from(activityObservations).orderBy(activityObservations.id).all()
  expect(calculateCanonicalIntervals(resolved(), policy)).toHaveLength(2)

  db.transaction((tx) => storeActivityEvidence(tx, parsed, '2026-09-26T05:00:00Z'))
  const after = db.select().from(activityObservations).orderBy(activityObservations.id).all()
  expect(after.filter((row) => !before.some((old) => old.id === row.id))).toHaveLength(
    progressIds(parsed).length
  )
  for (const row of before) expect(after).toContainEqual(row)
  expectParserIntervals(parsed, resolved())
})

it('keeps differing progress on one head as leaves but still holds a genuine message fork', async () => {
  const shared = longTool().slice(0, 6)
  const tail = [output(40), assistant(41)]
  await store([...shared, event(5, 'exec_command_begin', { command: ['a'] }), ...tail], 'a.jsonl')
  await store([...shared, event(6, 'exec_command_begin', { command: ['b'] }), ...tail], 'b.jsonl')
  const result = resolved()
  expect(
    result.events.filter((entry) => entry.timestamp === time(5) || entry.timestamp === time(6))
  ).toHaveLength(2)

  const forked = database()
  const prefix = [...shared, note(5)]
  await store([...prefix, user(30, 'first branch')], 'x.jsonl', forked.target)
  await store([...prefix, user(30, 'second branch')], 'y.jsonl', forked.target)
  held('branching-activity', forked.target)
})

it.each([
  ['unknown-ancestry', 15, (payload: Line) => delete payload.parentEventId],
  ['missing-predecessor', 15, (payload: Line) => (payload.parentEventId = 'codex:v1:native:gone')],
  ['invalid-observation', 15, (payload: Line) => (payload.text = 'PRIVATE_TRANSCRIPT')],
  ['invalid-observation', 15, (payload: Line) => (payload.kind = 'reasoning')],
  ['invalid-observation', 15, (payload: Line) => (payload.progressType = ' ')],
  ['invalid-observation', 15, (payload: Line) => (payload.timestamp = '2026-09-26T03:15:00')],
  // Anchored to the tool call, so it cannot move past the output or before the call.
  ['nonmonotonic-time', 15, (payload: Line) => (payload.timestamp = time(45))],
  ['nonmonotonic-time', 15, (payload: Line) => (payload.timestamp = time(1.9))],
  // Root-anchored progress cannot be moved after the first activity.
  ['nonmonotonic-time', 0.5, (payload: Line) => (payload.timestamp = time(3))]
])(
  'holds malformed or misplaced progress instead of using it as a bridge (%s)',
  async (reason, minute, change) => {
    const parsed = await store(longTool())
    const target = parsed.codexActivityEvidence!.progress.find(
      (progress) => progress.timestamp === time(minute)
    )!
    rewrite(target.eventId, change)
    held(reason)
  }
)

it('holds progress with conflicting observations and a progress ID used as an ancestor', async () => {
  const parsed = await store(longTool())
  const target = parsed.codexActivityEvidence!.progress.find(
    (progress) => progress.timestamp === time(15)
  )!
  db.insert(activityObservations)
    .values({
      id: 'observation:v1:fixture-conflict',
      eventId: target.eventId,
      version: 1,
      kind: 'activity',
      payloadJson: JSON.stringify({
        kind: 'progress',
        progressType: 'token_count',
        timestamp: time(16),
        parentEventId: target.parentEventId
      }),
      createdAt: '2026-09-26T05:00:00Z'
    })
    .run()
  held('conflicting-observations')

  const other = database()
  const again = await store(longTool(), 'again.jsonl', other.target)
  const toolOutput = again.messages[2].activityIdentity!.eventId
  const observation = other.target
    .select()
    .from(activityObservations)
    .all()
    .find((entry) => entry.eventId === toolOutput)!
  const payload = JSON.parse(observation.payloadJson)
  payload.parentEventId = progressIds(again)[3]
  other.connection
    .prepare('UPDATE activity_observations SET payload_json = ? WHERE id = ?')
    .run(JSON.stringify(payload), observation.id)
  held('missing-predecessor', other.target)
})

it('continues native identities across growth and holds a native record with conflicting facts', async () => {
  const lines = [
    meta(),
    turn(0, 'model-a'),
    user(1),
    call(2, { id: 'fc_1' }),
    tokens(2.1, 100, 0, 10),
    output(3),
    assistant(4, { id: 'msg_1' }),
    tokens(4.1, 150, 0, 20)
  ]
  await store(lines.slice(0, 5), 'live.jsonl')
  const parsed = await store(lines, 'live.jsonl')
  expect(
    db
      .select()
      .from(activityIdentities)
      .all()
      .filter((identity) => identity.basis === 'native')
      .map((identity) => identity.nativeEventId)
      .sort()
  ).toEqual(['fc_1', 'msg_1'])
  expectParserIntervals(parsed, resolved())
  await store([...lines.slice(0, 6), assistant(5, { id: 'msg_1' })], 'rewritten.jsonl')
  held('conflicting-observations')
})

it('never flattens divergent activity after a shared prefix', async () => {
  const shared = conversation().slice(0, 6)
  await store([...shared, user(30, 'first branch')], 'a.jsonl')
  await store([...shared, user(30, 'second branch')], 'b.jsonl')
  held('branching-activity')
})

it('never adds sibling checkpoint deltas recorded after the same activity', async () => {
  const shared = conversation().slice(0, 7)
  await store([...shared, tokens(20.1, 200, 20, 20)], 'a.jsonl')
  await store([...shared, tokens(20.2, 220, 20, 25)], 'b.jsonl')
  held('branching-checkpoints')
})

it('holds a corrected checkpoint while an independent conversation still resolves', async () => {
  await store(conversation())
  const corrected = conversation()
  corrected[8] = tokens(21.1, 260, 120, 30)
  await store(corrected, 'corrected.jsonl')
  await store([meta(OTHER_THREAD), ...conversation().slice(1)], 'independent.jsonl')
  const result = readCanonicalCodexActivity(db)
  expect(result.find((entry) => entry.conversationId === THREAD)).toMatchObject({
    status: 'unresolved',
    reason: 'unresolved-checkpoint',
    checkpoint: { reason: 'conflicting-observations' }
  })
  expect(result.find((entry) => entry.conversationId === OTHER_THREAD)).toMatchObject({
    status: 'resolved'
  })
})

const fewerCounters: Line = {
  timestamp: time(21.1),
  type: 'event_msg',
  payload: {
    type: 'token_count',
    info: { total_token_usage: { input_tokens: 250, cached_input_tokens: 120, output_tokens: 30 } }
  }
}
it.each([
  ['counter-decrease', tokens(21.1, 50, 0, 5)],
  ['counter-fields-changed', fewerCounters]
])('holds history whose checkpoint delta is %s instead of re-baselining', async (reason, last) => {
  const lines = conversation()
  lines[8] = last
  await store(lines)
  expect(held('unresolved-checkpoint')).toMatchObject({ checkpoint: { reason } })
})

it('holds history whose predecessor checkpoint is missing', async () => {
  const parsed = await store(conversation())
  const [root, child] = parsed.codexActivityEvidence!.checkpoints.map((checkpoint) => checkpoint.id)
  sqlite.pragma('foreign_keys = OFF')
  sqlite.prepare('DELETE FROM activity_observations WHERE event_id = ?').run(root)
  sqlite.prepare('DELETE FROM activity_identities WHERE event_id = ?').run(root)
  expect(held('unresolved-checkpoint')).toMatchObject({
    checkpoint: { checkpointId: child, reason: 'missing-predecessor' }
  })
})

it('holds cached deltas that exceed the input they are part of', async () => {
  const lines = conversation()
  lines[5] = tokens(2.1, 100, 0, 10)
  lines[8] = tokens(21.1, 110, 50, 20)
  await store(lines)
  held('invalid-usage-delta')
})

it.each([
  [
    'usage-mismatch',
    (payload: Record<string, unknown>) => {
      ;(payload.usage as Record<string, number>).inputTokens += 1
    }
  ],
  [
    'model-mismatch',
    (payload: Record<string, unknown>) => {
      payload.model = 'other-model'
    }
  ],
  [
    'invalid-observation',
    (payload: Record<string, unknown>) => {
      ;(payload.usage as Record<string, number>).cacheCreationInputTokens = 5
    }
  ],
  [
    'invalid-observation',
    (payload: Record<string, unknown>) => {
      payload.futureField = true
    }
  ],
  [
    'unknown-ancestry',
    (payload: Record<string, unknown>) => {
      delete payload.parentEventId
    }
  ]
])('holds a message observation the checkpoints do not justify (%s)', async (reason, change) => {
  const parsed = await store(conversation())
  rewrite(messageIds(parsed)[1], change)
  held(reason)
})

const bump = (field: string) => (delta: CodexCheckpointDelta) =>
  delta.status === 'resolved' && delta.previousCheckpointId !== null
    ? { ...delta, delta: { ...delta.delta, [field]: (delta.delta[field] ?? 0) + 1 } }
    : delta
it.each([
  ['a changed counter delta', bump('input_tokens')],
  ['a counter the evidence read does not have', bump('future_tokens')],
  [
    'a delta against another baseline',
    (delta: CodexCheckpointDelta) =>
      delta.status === 'resolved' && delta.previousCheckpointId !== null
        ? { ...delta, previousCheckpointId: null }
        : delta
  ]
])('holds checkpoint deltas not reproduced by the evidence read (%s)', async (_label, change) => {
  await store(conversation())
  resolved()
  tamper = change
  held('inconsistent-snapshot')
})

it('reads persisted coverage usage back exactly and rejects anything the adapter would not produce', async () => {
  await store(conversation())
  const { usage } = resolved()
  expect(usage.length).toBeGreaterThan(0)
  const persisted = JSON.parse(JSON.stringify(usage))
  expect(readCanonicalCoverageUsage(persisted)).toEqual(usage)
  expect(readCanonicalCoverageUsage([])).toEqual([])
  const changes: Array<(entry: Record<string, unknown>) => unknown> = [
    (entry) => (entry.futureField = true),
    (entry) => delete entry.usage,
    (entry) => (entry.checkpointId = ''),
    (entry) => (entry.observationId = ' '),
    (entry) => (entry.messageEventId = ''),
    (entry) => (entry.timestamp = (entry.timestamp as string).replace('.000Z', 'Z')),
    (entry) => (entry.timestamp = (entry.timestamp as string).replace('Z', '')),
    (entry) => (entry.model = 5),
    (entry) => ((entry.delta as Record<string, number>).output_tokens = -1),
    (entry) => ((entry.delta as Record<string, number>).total_tokens = 2 ** 53),
    (entry) => delete (entry.delta as Record<string, number>).cached_input_tokens,
    (entry) => {
      entry.delta = { input_tokens: 10, cached_input_tokens: 20, output_tokens: 0 }
      entry.usage = {
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 20
      }
    },
    (entry) => {
      entry.delta = { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0 }
      entry.usage = {
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0
      }
    },
    (entry) => ((entry.usage as Record<string, number>).inputTokens += 1),
    (entry) => ((entry.usage as Record<string, number>).cacheCreationInputTokens = 1),
    (entry) => ((entry.usage as Record<string, number>).futureTokens = 0)
  ]
  for (const [index, change] of changes.entries()) {
    const copy = JSON.parse(JSON.stringify(usage))
    change(copy[0])
    expect(readCanonicalCoverageUsage(copy), `change ${index}`).toBeNull()
  }
  expect(readCanonicalCoverageUsage([persisted[0], persisted[0]])).toBeNull()
  expect(readCanonicalCoverageUsage({ 0: persisted[0] })).toBeNull()
  expect(readCanonicalCoverageUsage([null])).toBeNull()
})

it.each([
  ['unsupported-version', 'UPDATE activity_observations SET version = 2'],
  ['unsupported-version', 'UPDATE activity_identities SET identity_version = 2'],
  ['unsupported-version', "UPDATE activity_identities SET basis = 'future'"],
  [
    'missing-observation',
    'DELETE FROM activity_observers; DELETE FROM activity_sources; DELETE FROM activity_observations'
  ]
])('holds incompatible or absent evidence (%s)', async (reason, sql) => {
  await store(conversation())
  sqlite.exec(sql)
  held(reason)
})
