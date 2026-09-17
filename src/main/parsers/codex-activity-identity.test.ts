// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

vi.mock('electron-log/main.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
}))
import { parseCodexSessionFile } from './codex-parser'

const timestamp = '2026-07-19T18:07:00.000Z'
const meta = (extra: Record<string, unknown> = {}) => ({
  timestamp,
  type: 'session_meta',
  payload: { id: 'thread-a', session_id: 'session-root', cwd: 'C:\\original', ...extra }
})
const item = (payload: Record<string, unknown>, at = timestamp) => ({
  timestamp: at,
  type: 'response_item',
  payload
})
const user = item({
  type: 'message',
  role: 'user',
  content: [{ type: 'input_text', text: 'Inspect the code' }]
})
const assistant = item(
  { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Done.' }] },
  '2026-07-19T18:07:01.000Z'
)
const native = item({ ...assistant.payload, id: 'message-1' }, assistant.timestamp)
const context = {
  timestamp,
  type: 'turn_context',
  payload: { model: 'fixture-model', cwd: 'C:\\original' }
}
const checkpoint = (input = 100, at = '2026-07-19T18:07:02.000Z') => ({
  timestamp: at,
  type: 'event_msg',
  payload: {
    type: 'token_count',
    info: {
      total_token_usage: {
        input_tokens: input,
        cached_input_tokens: 20,
        output_tokens: 10,
        reasoning_output_tokens: 3,
        total_tokens: input + 10
      },
      last_token_usage: {},
      model_context_window: 272000
    }
  }
})
let directory: string
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'clautime-codex-identity-'))
})
afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})
async function parse(name: string, records: unknown[]) {
  const path = join(directory, name)
  await writeFile(
    path,
    records
      .map((record) => (typeof record === 'string' ? record : JSON.stringify(record)))
      .join('\n') + '\n'
  )
  return (await parseCodexSessionFile(path))!
}

it('pins native, fallback and checkpoint encodings before ledger adoption', async () => {
  const parsed = await parse('golden.jsonl', [meta(), context, user, native, checkpoint()])
  expect(parsed.codexActivityEvidence).toMatchInlineSnapshot(`
    {
      "activities": [
        {
          "identity": {
            "basis": "fingerprint",
            "conversationId": "thread-a",
            "eventId": "codex:v1:fingerprint:f801a1602d730bfe63e0d812b0b0d2a21c866974d443e54794691a7aee39aa5e",
            "nativeEventId": null,
            "parentEventId": null,
            "provider": "codex",
            "version": 1,
          },
          "kind": "message",
          "timestamp": "2026-07-19T18:07:00.000Z",
        },
        {
          "identity": {
            "basis": "native",
            "conversationId": "thread-a",
            "eventId": "codex:v1:native:287e155279d7158813eb429053b07d3c3ab86db2baa571274fa6709f4f5d638c",
            "nativeEventId": "message-1",
            "parentEventId": "codex:v1:fingerprint:f801a1602d730bfe63e0d812b0b0d2a21c866974d443e54794691a7aee39aa5e",
            "provider": "codex",
            "version": 1,
          },
          "kind": "message",
          "timestamp": "2026-07-19T18:07:01.000Z",
        },
      ],
      "checkpoints": [
        {
          "activityEventId": "codex:v1:native:287e155279d7158813eb429053b07d3c3ab86db2baa571274fa6709f4f5d638c",
          "id": "codex:v1:checkpoint:7e6d2c7c69f74bfcfcae2bca20897679b320aa89ca4e3d7e025a28229022a8ff",
          "model": "fixture-model",
          "previousCheckpointId": null,
          "timestamp": "2026-07-19T18:07:02.000Z",
          "totals": {
            "cached_input_tokens": 20,
            "input_tokens": 100,
            "output_tokens": 10,
            "reasoning_output_tokens": 3,
            "total_tokens": 110,
          },
        },
      ],
      "reason": null,
      "status": "captured",
      "version": 1,
    }
  `)
})

it('converges copies despite file moves, metadata changes and shifted synthetic line IDs', async () => {
  const a = await parse('original.jsonl', [meta(), context, user, native, checkpoint()])
  const b = await parse('renamed.jsonl', [
    meta({ cwd: '/new/location', cli_version: 'different', machine_id: 'other' }),
    { ...context, payload: { model: 'changed-model', cwd: '/new/location' } },
    { timestamp, type: 'event_msg', payload: { type: 'task_started' } },
    user,
    native,
    checkpoint()
  ])
  expect(a.messages[0].uuid).not.toBe(b.messages[0].uuid)
  expect(a.messages.map((m) => m.activityIdentity)).toEqual(
    b.messages.map((m) => m.activityIdentity)
  )
  expect(a.codexActivityEvidence!.checkpoints[0].id).toBe(
    b.codexActivityEvidence!.checkpoints[0].id
  )
  expect(b.codexActivityEvidence!.checkpoints[0].model).toBe('changed-model')
  expect(a.totalTokenUsage).toEqual(b.totalTokenUsage)
  expect(JSON.stringify(a.codexActivityEvidence)).not.toContain('Inspect the code')
})

it('keeps divergent continuations distinct even when their later payloads match again', async () => {
  const branch = item(
    { ...assistant.payload, content: [{ type: 'output_text', text: 'Different continuation' }] },
    assistant.timestamp
  )
  const later = item(
    { type: 'function_call', call_id: 'call-a', name: 'shell', arguments: '{"command":"pwd"}' },
    '2026-07-19T18:07:03Z'
  )
  const a = await parse('a.jsonl', [
    meta(),
    user,
    assistant,
    checkpoint(),
    later,
    checkpoint(140, '2026-07-19T18:07:04Z')
  ])
  const b = await parse('b.jsonl', [
    meta(),
    user,
    branch,
    checkpoint(),
    later,
    checkpoint(150, '2026-07-19T18:07:04Z')
  ])
  const aIds = a.messages.map((m) => m.activityIdentity!.eventId)
  const bIds = b.messages.map((m) => m.activityIdentity!.eventId)
  expect(aIds[0]).toBe(bIds[0])
  expect(new Set([...aIds, ...bIds]).size).toBe(5)
  expect(aIds[2]).not.toBe(bIds[2])
  expect(a.codexActivityEvidence!.checkpoints[0].id).not.toBe(
    b.codexActivityEvidence!.checkpoints[0].id
  )
  for (const parsed of [a, b]) {
    const checkpoints = parsed.codexActivityEvidence!.checkpoints
    expect(checkpoints[0].previousCheckpointId).toBeNull()
    expect(checkpoints[1].previousCheckpointId).toBe(checkpoints[0].id)
  }
})

it('preserves original cumulative counters and stable keys across usage corrections', async () => {
  const tail = item(
    { ...user.payload, content: [{ type: 'input_text', text: 'Next task' }] },
    '2026-07-19T18:07:03Z'
  )
  const a = await parse('before.jsonl', [
    meta(),
    context,
    user,
    assistant,
    checkpoint(),
    tail,
    checkpoint(160, '2026-07-19T18:07:04Z')
  ])
  const b = await parse('corrected.jsonl', [
    meta(),
    context,
    user,
    assistant,
    checkpoint(120),
    tail,
    checkpoint(180, '2026-07-19T18:07:04Z')
  ])
  expect(a.messages.map((m) => m.activityIdentity)).toEqual(
    b.messages.map((m) => m.activityIdentity)
  )
  expect(a.codexActivityEvidence!.checkpoints.map((c) => [c.id, c.previousCheckpointId])).toEqual(
    b.codexActivityEvidence!.checkpoints.map((c) => [c.id, c.previousCheckpointId])
  )
  expect(b.codexActivityEvidence!.checkpoints[0].totals).toEqual(
    checkpoint(120).payload.info.total_token_usage
  )
  expect(a.totalTokenUsage.inputTokens).toBe(140)
  expect(b.totalTokenUsage.inputTokens).toBe(160)
})

it('keeps repeated checkpoint observations without creating self-links or rewinding the chain', async () => {
  const first = checkpoint()
  const second = checkpoint(140, '2026-07-19T18:07:03Z')
  const third = checkpoint(180, '2026-07-19T18:07:04Z')
  const parsed = await parse('repeat.jsonl', [
    meta(),
    user,
    assistant,
    first,
    checkpoint(120),
    second,
    first,
    third
  ])
  const checkpoints = parsed.codexActivityEvidence!.checkpoints
  expect(checkpoints).toHaveLength(5)
  expect(checkpoints[1]).toMatchObject({ id: checkpoints[0].id, previousCheckpointId: null })
  expect(checkpoints[3]).toEqual(checkpoints[0])
  expect(checkpoints[4].previousCheckpointId).toBe(checkpoints[2].id)
  expect(checkpoints.every((c) => c.id !== c.previousCheckpointId)).toBe(true)
})

it('captures compaction and reasoning ancestry before the parser discards their payloads', async () => {
  const reasoning = item({
    type: 'reasoning',
    id: 'reasoning-1',
    summary: [{ type: 'summary_text', text: 'Plan' }]
  })
  const compact = {
    timestamp,
    type: 'compacted',
    payload: { message: 'Summary', replacement_history: [] }
  }
  const a = await parse('a.jsonl', [meta(), user, reasoning, compact, assistant, checkpoint()])
  const b = await parse('b.jsonl', [
    meta(),
    user,
    reasoning,
    { ...compact, payload: { message: 'Different summary', replacement_history: [] } },
    assistant,
    checkpoint()
  ])
  expect(a.codexActivityEvidence!.activities.map((event) => event.kind)).toEqual([
    'message',
    'reasoning',
    'compacted',
    'message'
  ])
  expect(a.messages[1].activityIdentity!.parentEventId).toBe(
    a.codexActivityEvidence!.activities[2].identity.eventId
  )
  expect(a.messages[1].activityIdentity!.eventId).not.toBe(b.messages[1].activityIdentity!.eventId)
  expect(a.messages).toHaveLength(2)
})

it('separates tool calls and outputs sharing a call ID and retains original arguments', async () => {
  const call = item({
    type: 'function_call',
    call_id: 'call-1',
    name: 'shell',
    arguments: '{"command":"pwd"}'
  })
  const output = item({ type: 'function_call_output', call_id: 'call-1', output: 'project' })
  const a = await parse('a.jsonl', [meta(), call, output])
  const b = await parse('b.jsonl', [
    meta(),
    item({ ...call.payload, arguments: '{"command":"ls"}' }),
    output
  ])
  expect(new Set(a.messages.map((m) => m.activityIdentity!.eventId)).size).toBe(2)
  expect(a.messages[0].activityIdentity!.eventId).not.toBe(b.messages[0].activityIdentity!.eventId)
  expect(a.messages[1].isToolResult).toBe(true)
})

it('scopes identical native IDs by recorded thread, not the shared root session', async () => {
  const a = await parse('root.jsonl', [meta(), native])
  const b = await parse('agent.jsonl', [
    meta({ id: 'thread-agent', parent_thread_id: 'thread-a' }),
    native
  ])
  expect(a.messages[0].activityIdentity!.conversationId).toBe('thread-a')
  expect(b.messages[0].activityIdentity!.conversationId).toBe('thread-agent')
  expect(a.messages[0].activityIdentity!.eventId).not.toBe(b.messages[0].activityIdentity!.eventId)
})

it('keeps native item identities stable on replay and ignores mutable payload measurements', async () => {
  const corrected = {
    ...native,
    payload: { ...native.payload, usage: { input_tokens: 100 }, model: 'corrected' }
  }
  const a = await parse('a.jsonl', [meta(), user, native, corrected, assistant])
  const b = await parse('b.jsonl', [meta(), user, native, assistant])
  expect(a.messages[1].activityIdentity).toEqual(a.messages[2].activityIdentity)
  expect(a.messages[3].activityIdentity).toEqual(b.messages[2].activityIdentity)
  expect(a.codexActivityEvidence!.activities).toHaveLength(3)
})

it.each([
  { forked_from_id: 'source-thread' },
  { history_base: { thread_id: 'source-thread', ordinal: 4 } },
  { subagent_history_start_ordinal: 4 },
  { history_mode: 'paginated' }
])('leaves unresolved inherited history unclassified: %j', async (fields) => {
  const parsed = await parse('fork.jsonl', [meta(fields), user, assistant, checkpoint()])
  expect(parsed.codexActivityEvidence).toMatchObject({
    status: 'unavailable',
    reason: 'unresolved-fork-history',
    activities: [],
    checkpoints: []
  })
  expect(parsed.messages.every((m) => m.activityIdentity === null)).toBe(true)
  expect(parsed.totalTokenUsage.inputTokens).toBe(80)
})

it.each([
  'missing header',
  'missing thread ID',
  'malformed',
  'changed header',
  'invalid timestamp',
  'invalid usage'
])('preserves local parsing while refusing incomplete identity evidence: %s', async (reason) => {
  const records: unknown[] =
    reason === 'missing header'
      ? [user]
      : [meta(reason === 'missing thread ID' ? { id: undefined } : {}), user]
  if (reason === 'malformed') records.push('{broken')
  if (reason === 'changed header') records.push(meta({ id: 'different-thread' }))
  records.push(
    reason === 'invalid timestamp' ? { ...assistant, timestamp: '2026-07-19T18:07:01' } : assistant
  )
  if (reason === 'invalid usage') records.push(checkpoint(-1))
  const parsed = await parse('filename-cannot-supply-identity.jsonl', records)
  expect(parsed.messages).toHaveLength(2)
  expect(parsed.messages.every((m) => m.activityIdentity === null)).toBe(true)
  expect(parsed.codexActivityEvidence).toMatchObject({
    status: 'unavailable',
    activities: [],
    checkpoints: []
  })
})

it('retains counter drops as observations without guessing a reset or manufacturing a zero checkpoint', async () => {
  const parsed = await parse('drops.jsonl', [
    meta(),
    user,
    assistant,
    checkpoint(200),
    { timestamp, type: 'event_msg', payload: { type: 'token_count', info: null } },
    checkpoint(100, '2026-07-19T18:07:03Z')
  ])
  expect(parsed.codexActivityEvidence!.checkpoints.map((c) => c.totals.input_tokens)).toEqual([
    200, 100
  ])
  expect(parsed.codexActivityEvidence!.status).toBe('captured')
})
