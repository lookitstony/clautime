// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

vi.mock('electron-log/main.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
}))
import { parseGeminiSessionFile } from './gemini-parser'

const timestamp = '2026-07-19T18:07:00.000Z'
const user = { id: 'user-1', timestamp, type: 'user', content: [{ text: 'Inspect the code' }] }
const response = {
  id: 'response-1',
  timestamp: '2026-07-19T18:07:01.000Z',
  type: 'gemini',
  content: 'Done.',
  model: 'fixture-model',
  tokens: { input: 100, cached: 20, output: 10, thoughts: 3, tool: 2, total: 115 }
}
let directory: string
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'clautime-gemini-identity-'))
})
afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})
async function parse(name: string, messages: unknown[], extra: Record<string, unknown> = {}) {
  const path = join(directory, name)
  await writeFile(
    path,
    JSON.stringify({
      sessionId: 'conversation-a',
      projectHash: 'original-project',
      startTime: timestamp,
      lastUpdated: response.timestamp,
      messages,
      ...extra
    })
  )
  return (await parseGeminiSessionFile(path))!
}

it('pins native and fallback key encodings before ledger adoption', async () => {
  const parsed = await parse('golden.json', [user, { ...response, id: undefined }])
  expect(parsed.messages.map((message) => message.activityIdentity)).toMatchInlineSnapshot(`
    [
      {
        "basis": "native",
        "conversationId": "conversation-a",
        "eventId": "gemini:v1:native:e079e675076841ba4791b6fadf20d4a1970c19288490d6cd43dea225ad45b331",
        "nativeEventId": "user-1",
        "parentEventId": null,
        "provider": "gemini",
        "version": 1,
      },
      {
        "basis": "fingerprint",
        "conversationId": "conversation-a",
        "eventId": "gemini:v1:fingerprint:37ac1430bcd2351f753357ed0c19f8e1b7d5f43abbd7f6c15cf2b00d87637eb8",
        "nativeEventId": null,
        "parentEventId": "gemini:v1:native:e079e675076841ba4791b6fadf20d4a1970c19288490d6cd43dea225ad45b331",
        "provider": "gemini",
        "version": 1,
      },
    ]
  `)
})

it('captures native identities and original array ancestry before timestamp sorting', async () => {
  const parsed = await parse('native.json', [user, { ...response, timestamp }])
  const [first, second] = parsed.messages.map((message) => message.activityIdentity!)
  expect(first).toMatchObject({
    version: 1,
    provider: 'gemini',
    conversationId: 'conversation-a',
    nativeEventId: user.id,
    basis: 'native',
    parentEventId: null
  })
  expect(second.parentEventId).toBe(first.eventId)
  expect(parsed.geminiActivityEvidence?.status).toBe('captured')
  expect(parsed.totalTokenUsage).toEqual({
    inputTokens: 82,
    outputTokens: 13,
    cacheReadInputTokens: 20,
    cacheCreationInputTokens: 0
  })
})

it('keeps native identities through moved files, metadata changes and response updates', async () => {
  const before = await parse('original.json', [user, response])
  expect(before.messages[1].activityIdentity?.basis).toBe('native')
  const after = await parse(
    'moved.json',
    [user, { ...response, content: 'Completed.', model: 'corrected', tokens: { input: 200 } }],
    { projectHash: 'different-path', lastUpdated: timestamp, directories: ['D:/elsewhere'] }
  )
  expect(after.messages.map((message) => message.activityIdentity)).toEqual(
    before.messages.map((message) => message.activityIdentity)
  )
  expect(after.totalTokenUsage.inputTokens).toBe(200)
})

it('namespaces reused message IDs by the recorded conversation', async () => {
  const first = await parse('first.json', [user])
  const second = await parse('second.json', [user], { sessionId: 'conversation-b' })
  expect(first.messages[0].activityIdentity!.eventId).not.toBe(
    second.messages[0].activityIdentity!.eventId
  )
})

it('keeps separate native responses with identical payloads distinct', async () => {
  const parsed = await parse('distinct.json', [user, response, { ...response, id: 'response-2' }])
  expect(parsed.messages[2].activityIdentity!.eventId).not.toBe(
    parsed.messages[1].activityIdentity!.eventId
  )
})

it('keeps a native response and its successor stable as embedded tool results arrive', async () => {
  const tool = { id: 'call-1', name: 'read_file', args: { path: 'file.ts' }, status: 'executing' }
  const tail = { ...user, id: undefined, content: 'Continue', timestamp: response.timestamp }
  const before = await parse('before.json', [user, { ...response, toolCalls: [tool] }, tail])
  const after = await parse('after.json', [
    user,
    {
      ...response,
      toolCalls: [{ ...tool, status: 'success', result: [{ text: 'file content' }] }]
    },
    tail
  ])
  expect(after.messages.map((message) => message.activityIdentity)).toEqual(
    before.messages.map((message) => message.activityIdentity)
  )
  expect(after.messages[1].toolNames).toEqual(['read_file'])
})

it('deduplicates copied prefixes and distinguishes divergent fallback continuations', async () => {
  const fallback = { ...response, id: undefined }
  const tail = { ...fallback, timestamp: '2026-07-19T18:07:02.000Z', content: 'Next.' }
  const first = await parse('first.json', [user, fallback, tail])
  const copied = await parse('copy.json', [user, fallback, tail])
  const branch = await parse('branch.json', [user, { ...fallback, content: 'Different.' }, tail])
  const ids = (data: typeof first) =>
    data.messages.map((message) => message.activityIdentity!.eventId)
  expect(ids(copied)).toEqual(ids(first))
  expect(ids(branch)[0]).toBe(ids(first)[0])
  expect(ids(branch)[1]).not.toBe(ids(first)[1])
  expect(ids(branch)[2]).not.toBe(ids(first)[2])
})

it('ignores mutable measurements and object key order in fallback fingerprints', async () => {
  const original = {
    ...response,
    id: undefined,
    content: [{ functionCall: { name: 'read_file', args: { path: 'a.ts', limit: 2 } } }]
  }
  const corrected = {
    ...original,
    model: 'corrected',
    tokens: { input: 500 },
    content: [{ functionCall: { args: { limit: 2, path: 'a.ts' }, name: 'read_file' } }]
  }
  const first = await parse('first.json', [user, original])
  expect(first.messages[1].activityIdentity?.basis).toBe('fingerprint')
  const second = await parse('second.json', [user, corrected])
  expect(second.messages[1].activityIdentity).toEqual(first.messages[1].activityIdentity)
})

it.each([
  { content: 'Different response' },
  { thoughts: [{ subject: 'Plan', description: 'Different reasoning', timestamp }] },
  { toolCalls: [{ id: 'call-1', name: 'read_file', args: { path: 'different.ts' } }] },
  { timestamp: '2026-07-19T18:07:01.000001Z' }
])('retains original fallback payload distinctions: %j', async (change) => {
  const fallback = { ...response, id: undefined }
  const first = await parse('first.json', [user, fallback])
  const second = await parse('second.json', [user, { ...fallback, ...change }])
  expect(second.messages[1].activityIdentity!.eventId).not.toBe(
    first.messages[1].activityIdentity!.eventId
  )
})

it('retains progress records in ancestry even though they are not normalized messages', async () => {
  const info = { id: 'info-1', type: 'info', timestamp, content: 'Context compressed' }
  const parsed = await parse('progress.json', [user, info, response])
  const evidence = parsed.geminiActivityEvidence!
  expect(evidence.activities.map((activity) => activity.kind)).toEqual(['user', 'info', 'gemini'])
  expect(parsed.messages).toHaveLength(2)
  expect(parsed.progressTimestamps).toEqual([timestamp])
  expect(parsed.messages[1].activityIdentity!.parentEventId).toBe(
    evidence.activities[1].identity.eventId
  )
})

it('retains repeated native observations without rewinding the predecessor chain', async () => {
  const tail = { ...response, id: undefined, content: 'Next.' }
  const parsed = await parse('repeat.json', [user, response, user, tail])
  const evidence = parsed.geminiActivityEvidence!
  expect(evidence.activities).toHaveLength(4)
  expect(evidence.activities[2].identity).toEqual(evidence.activities[0].identity)
  expect(evidence.activities[3].identity.parentEventId).toBe(
    evidence.activities[1].identity.eventId
  )
})

it.each([
  ['missing session ID', { sessionId: undefined }, [user, response]],
  ['blank session ID', { sessionId: ' ' }, [user, response]],
  ['missing timestamp', {}, [user, { ...response, timestamp: undefined }]],
  ['unzoned timestamp', {}, [user, { ...response, timestamp: '2026-07-19T18:07:01' }]],
  ['invalid record', {}, [user, null, response]],
  ['unknown record shape', {}, [user, { timestamp }, response]],
  ['missing fallback payload', {}, [user, { ...response, id: undefined, content: undefined }]]
])('leaves incomplete evidence unavailable: %s', async (_name, metadata, records) => {
  const parsed = await parse('incomplete.json', records, metadata)
  expect(parsed.geminiActivityEvidence).toMatchObject({ status: 'unavailable', activities: [] })
  expect(parsed.messages.length).toBeGreaterThan(0)
  expect(parsed.messages.every((message) => message.activityIdentity === null)).toBe(true)
})

it('does not let timestamp sorting rewrite observed predecessor links', async () => {
  const parsed = await parse('out-of-order.json', [response, user])
  expect(parsed.messages[0].uuid).toBe(user.id)
  expect(parsed.messages[0].activityIdentity!.parentEventId).toBe(
    parsed.messages[1].activityIdentity!.eventId
  )
  expect(parsed.messages[1].activityIdentity!.parentEventId).toBeNull()
})
