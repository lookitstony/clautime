// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { claudeActivityIdentity } from './claude-activity-identity'

vi.mock('electron-log/main.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
}))
import { parseSessionFile } from './session-parser'

const root = {
  type: 'user',
  sessionId: 'conversation-1',
  uuid: 'event-1',
  parentUuid: null,
  timestamp: '2026-03-04T10:00:00.000Z',
  cwd: 'C:\\original',
  message: { role: 'user', content: 'Inspect the project' }
}
const assistant = {
  type: 'assistant',
  sessionId: root.sessionId,
  uuid: 'event-2',
  parentUuid: root.uuid,
  timestamp: '2026-03-04T10:00:01.000Z',
  cwd: root.cwd,
  message: {
    role: 'assistant',
    model: 'fixture-model',
    content: [
      { type: 'tool_use', id: 'call-1', name: 'Read', input: { file_path: 'README.md', limit: 20 } }
    ],
    usage: { input_tokens: 10, output_tokens: 5 }
  }
}
let directory: string
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'clautime-identity-'))
})
afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})
const jsonl = (records: unknown[]) =>
  records.map((record) => JSON.stringify(record)).join('\n') + '\n'
async function parse(name: string, records: unknown[]) {
  const path = join(directory, name)
  await writeFile(path, jsonl(records))
  return (await parseSessionFile(path))!
}

it('pins the native v1 identity format and records parent lineage', () => {
  expect(claudeActivityIdentity(root)).toMatchInlineSnapshot(`
    {
      "basis": "native",
      "conversationId": "conversation-1",
      "eventId": "claude:v1:native:cd72146208a138399e9e5cdd524c3f9799e523a974e988da3d76d632459ae7ed",
      "nativeEventId": "event-1",
      "parentEventId": null,
      "provider": "claude",
      "version": 1,
    }
  `)
  expect(claudeActivityIdentity(assistant)?.parentEventId).toBe(
    claudeActivityIdentity(root)?.eventId
  )
})

it('converges copied prefixes across paths while preserving divergent continuations', async () => {
  const tail = {
    ...root,
    uuid: 'tail-a',
    parentUuid: assistant.uuid,
    timestamp: '2026-03-04T10:01:00Z'
  }
  const a = await parse('original.jsonl', [root, assistant, tail])
  const b = await parse('renamed-copy.jsonl', [
    { type: 'file-history-snapshot', snapshot: {} },
    { ...root, cwd: '/moved/project', gitBranch: 'different-local-branch', machineId: 'second' },
    { ...assistant, cwd: '/moved/project' },
    { ...tail, uuid: 'tail-b', message: { role: 'user', content: 'Different continuation' } }
  ])
  const idsA = a.messages.map((m) => m.activityIdentity!.eventId)
  const idsB = b.messages.map((m) => m.activityIdentity!.eventId)
  expect(idsA.slice(0, 2)).toEqual(idsB.slice(0, 2))
  expect(new Set([...idsA, ...idsB]).size).toBe(4)
  expect(b.messages[2].activityIdentity!.parentEventId).toBe(idsA[1])
  expect(JSON.stringify(a.messages)).not.toContain('Inspect the project')
})

it.each([true, false])(
  'keeps identity stable across token/model corrections (native ID: %s)',
  async (native) => {
    const original = { ...assistant, uuid: native ? assistant.uuid : undefined }
    const corrected = {
      ...original,
      message: {
        ...original.message,
        model: 'corrected-model',
        usage: { input_tokens: 200, output_tokens: 50 }
      }
    }
    const a = await parse('before.jsonl', [root, original])
    const b = await parse('after.jsonl', [root, corrected])
    expect(a.messages[1].activityIdentity).not.toBeNull()
    expect(a.messages[1].activityIdentity).toEqual(b.messages[1].activityIdentity)
    expect(a.totalTokenUsage.inputTokens).toBe(10)
    expect(b.totalTokenUsage.inputTokens).toBe(200)
  }
)

it('pins fallback v1 identity and ignores JSON key order and local metadata', () => {
  const raw = { ...assistant, uuid: undefined }
  const identity = claudeActivityIdentity(raw)
  expect(identity).toMatchInlineSnapshot(`
    {
      "basis": "fingerprint",
      "conversationId": "conversation-1",
      "eventId": "claude:v1:fingerprint:e2441d5317261aa9ce0482ad7a419e95950795b881098fbf7d87c2e378eccaa2",
      "nativeEventId": null,
      "parentEventId": "claude:v1:native:cd72146208a138399e9e5cdd524c3f9799e523a974e988da3d76d632459ae7ed",
      "provider": "claude",
      "version": 1,
    }
  `)
  expect(
    claudeActivityIdentity({
      ...raw,
      cwd: '/elsewhere',
      gitBranch: 'local',
      message: {
        ...raw.message,
        content: [
          {
            input: { limit: 20, file_path: 'README.md' },
            name: 'Read',
            id: 'call-1',
            type: 'tool_use'
          }
        ]
      }
    })
  ).toEqual(identity)
})

it.each([false, true])(
  'distinguishes provider response IDs while retaining correction and payload identity (subagent: %s)',
  async (subagent) => {
    const first = {
      ...assistant,
      uuid: undefined,
      ...(subagent ? { isSidechain: true, agentId: 'agent-response-ids' } : {}),
      message: {
        ...assistant.message,
        id: 'msg_first_response',
        content: [{ type: 'text', text: 'Done.' }]
      }
    }
    const second = { ...first, message: { ...first.message, id: 'msg_second_response' } }
    const corrected = {
      ...first,
      message: {
        ...first.message,
        model: 'corrected-model',
        usage: { input_tokens: 200, output_tokens: 50 }
      }
    }
    const anotherBlock = {
      ...first,
      message: { ...first.message, content: [{ type: 'text', text: 'Another response block.' }] }
    }
    const records = [first, second, corrected, anotherBlock]
    if (subagent) {
      const subdir = join(directory, root.sessionId, 'subagents')
      await mkdir(subdir, { recursive: true })
      await writeFile(join(subdir, 'agent-responses.jsonl'), jsonl(records))
    }
    const parsed = await parse(`${root.sessionId}.jsonl`, [root, ...(subagent ? [] : records)])
    const messages = subagent ? parsed.subagentMessages : parsed.messages.slice(1)
    const identities = messages.map((message) => message.activityIdentity!)
    expect(identities.every((identity) => identity.basis === 'fingerprint')).toBe(true)
    expect(identities[1].eventId).not.toBe(identities[0].eventId)
    expect(identities[2]).toEqual(identities[0])
    expect(identities[3].eventId).not.toBe(identities[0].eventId)
    expect(messages[2].usage?.inputTokens).toBe(200)
    expect(claudeActivityIdentity({ ...first, uuid: assistant.uuid })).toEqual(
      claudeActivityIdentity({ ...second, uuid: assistant.uuid })
    )
  }
)

it('distinguishes fallback payloads and predecessors that the old parser discards', async () => {
  const raw = { ...assistant, uuid: undefined }
  const differentContent = {
    ...raw,
    message: {
      ...raw.message,
      content: [{ ...raw.message.content[0], input: { file_path: 'package.json', limit: 20 } }]
    }
  }
  const differentParent = { ...raw, parentUuid: 'other-branch-event' }
  const a = await parse('a.jsonl', [raw])
  const b = await parse('b.jsonl', [differentContent])
  const c = await parse('c.jsonl', [differentParent])
  const { activityIdentity: aId, ...aMetadata } = a.messages[0]
  const { activityIdentity: bId, ...bMetadata } = b.messages[0]
  expect(aMetadata).toEqual(bMetadata)
  expect(new Set([aId!.eventId, bId!.eventId, c.messages[0].activityIdentity!.eventId]).size).toBe(
    3
  )
})

it('keeps timestamp precision beyond milliseconds in fallback identities', () => {
  const a = claudeActivityIdentity({
    ...assistant,
    uuid: undefined,
    timestamp: '2026-03-04T10:00:01.000001Z'
  })
  const b = claudeActivityIdentity({
    ...assistant,
    uuid: undefined,
    timestamp: '2026-03-04T10:00:01.000002Z'
  })
  expect(a).not.toBeNull()
  expect(b).not.toBeNull()
  expect(a!.eventId).not.toBe(b!.eventId)
})

it('does not infer a subagent stream from its filename when the sidechain marker is absent', async () => {
  const subdir = join(directory, root.sessionId, 'subagents')
  await mkdir(subdir, { recursive: true })
  await writeFile(
    join(subdir, 'agent-name-is-not-identity.jsonl'),
    jsonl([{ ...assistant, uuid: undefined }])
  )
  const parsed = await parse(`${root.sessionId}.jsonl`, [root])
  expect(parsed.subagentMessages[0].activityIdentity).toBeNull()
})

it('preserves native compaction boundaries and separates overlapping subagents without filename identity', async () => {
  const subdir = join(directory, root.sessionId, 'subagents')
  await mkdir(subdir, { recursive: true })
  const sub = { ...assistant, uuid: undefined, isSidechain: true, agentId: 'agent-a' }
  await writeFile(join(subdir, 'agent-renamed.jsonl'), jsonl([sub]))
  await writeFile(join(subdir, 'agent-second.jsonl'), jsonl([{ ...sub, agentId: 'agent-b' }]))
  const boundary = {
    type: 'system',
    subtype: 'compact_boundary',
    sessionId: root.sessionId,
    timestamp: '2026-03-04T10:00:02Z',
    uuid: 'compact-1',
    parentUuid: assistant.uuid,
    compactMetadata: { trigger: 'auto', preTokens: 200 }
  }
  const result = await parse(`${root.sessionId}.jsonl`, [root, assistant, boundary])
  expect(result.messages[2].activityIdentity).toMatchObject({
    basis: 'native',
    nativeEventId: 'compact-1',
    parentEventId: result.messages[1].activityIdentity!.eventId
  })
  expect(new Set(result.subagentMessages.map((m) => m.activityIdentity!.eventId)).size).toBe(2)
  expect(claudeActivityIdentity({ ...sub, agentId: undefined }, true)).toBeNull()
})

it('produces the same fallback identity for an incremental tail as a full parse', async () => {
  const path = join(directory, 'incremental.jsonl')
  const initial = jsonl([root, assistant])
  await writeFile(path, initial)
  const tail = {
    ...root,
    uuid: undefined,
    parentUuid: assistant.uuid,
    timestamp: '2026-03-04T10:02:00Z'
  }
  await writeFile(path, initial + jsonl([tail]))
  const incremental = await parseSessionFile(path, {
    offsets: { [path]: Buffer.byteLength(initial) }
  })
  const full = await parseSessionFile(path)
  expect(incremental!.messages).toHaveLength(1)
  expect(incremental!.messages[0].activityIdentity).toEqual(full!.messages[2].activityIdentity)
  expect(incremental!.messages[0].activityIdentity?.basis).toBe('fingerprint')
})

it.each([
  { sessionId: undefined },
  { sessionId: '' },
  { parentUuid: undefined, uuid: undefined },
  { timestamp: 'invalid', uuid: undefined },
  { timestamp: '2026-03-04T10:00:00', uuid: undefined },
  { message: {}, uuid: undefined },
  { isSidechain: true, uuid: undefined },
  { type: 'unknown', uuid: undefined }
])('leaves incomplete identity evidence unclassified: %j', async (patch) => {
  const raw = { ...root, ...patch }
  expect(claudeActivityIdentity(raw)).toBeNull()
  if (raw.type !== 'unknown') {
    const parsed = await parse('filename-must-not-supply-identity.jsonl', [raw])
    expect(parsed.messages[0].activityIdentity).toBeNull()
  }
})

it('scopes native IDs by recorded conversation and keeps unknown parents distinct from roots', () => {
  expect(claudeActivityIdentity({ ...root, sessionId: 'another-conversation' })!.eventId).not.toBe(
    claudeActivityIdentity(root)!.eventId
  )
  expect(claudeActivityIdentity({ ...root, parentUuid: undefined })!.parentEventId).toBeUndefined()
  expect(claudeActivityIdentity(root)!.parentEventId).toBeNull()
})
