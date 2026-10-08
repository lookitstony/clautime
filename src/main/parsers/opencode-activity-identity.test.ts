// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm, rmdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

vi.mock('electron-log', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
}))
import { parseOpencodeSessionFile } from './opencode-parser'
import { OpencodeIdentityCapture } from './opencode-activity-identity'

const timestamp = Date.parse('2026-07-19T18:07:00.000Z')
const user = { id: 'msg_user', sessionID: 'ses_a', role: 'user', time: { created: timestamp } }
const assistant = {
  id: 'msg_reply',
  sessionID: 'ses_a',
  role: 'assistant',
  parentID: 'msg_user',
  time: { created: timestamp + 1000, completed: timestamp + 2000 },
  modelID: 'fixture-model',
  tokens: { input: 100, output: 10, reasoning: 3, cache: { read: 20, write: 2 } }
}
const textPart = {
  id: 'prt_text',
  sessionID: 'ses_a',
  messageID: 'msg_user',
  type: 'text',
  text: 'Hello'
}
const toolPart = {
  id: 'prt_tool',
  sessionID: 'ses_a',
  messageID: 'msg_reply',
  type: 'tool',
  callID: 'call_a',
  tool: 'read',
  state: { status: 'running', input: { path: 'a.ts' }, time: { start: timestamp + 1100 } }
}
let directory: string
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'clautime-opencode-identity-'))
})
afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})

async function fixture(
  name: string,
  messages: Record<string, unknown>[] = [user, assistant],
  parts: Record<string, unknown>[] = [textPart, toolPart],
  metadata: Record<string, unknown> = {}
) {
  const root = join(directory, name, 'storage')
  const info = { id: 'ses_a', directory: 'C:/original', ...metadata }
  const sessionId = String(info.id || 'ses_a')
  const sessionDir = join(root, 'session', 'project')
  const messageDir = join(root, 'message', sessionId)
  await mkdir(sessionDir, { recursive: true })
  await mkdir(messageDir, { recursive: true })
  const path = join(sessionDir, `${sessionId}.json`)
  await writeFile(path, JSON.stringify(info))
  for (const [index, message] of messages.entries()) {
    // Physical filenames deliberately differ from recorded IDs.
    await writeFile(join(messageDir, `msg_file_${index}.json`), JSON.stringify(message))
    if (typeof message.id === 'string' && message.id)
      await mkdir(join(root, 'part', message.id), { recursive: true })
  }
  for (const [index, part] of parts.entries()) {
    const owner = String(part.messageID || 'msg_reply')
    await mkdir(join(root, 'part', owner), { recursive: true })
    await writeFile(join(root, 'part', owner, `prt_file_${index}.json`), JSON.stringify(part))
  }
  return { root, path, messageDir }
}
async function parse(...args: Parameters<typeof fixture>) {
  return (await parseOpencodeSessionFile((await fixture(...args)).path))!
}

it('captures native messages, parts and explicit ownership/reply links', async () => {
  const parsed = await parse('native')
  const evidence = parsed.opencodeActivityEvidence!
  expect(evidence.status).toBe('captured')
  expect(evidence.activities).toHaveLength(4)
  const [prompt, reply] = parsed.messages.map((message) => message.activityIdentity!)
  expect(prompt.parentEventId).toBeUndefined()
  expect(reply.parentEventId).toBe(prompt.eventId)
  const tool = evidence.activities.find((activity) => activity.kind === 'tool')!
  expect(tool.identity.parentEventId).toBe(reply.eventId)
  expect(tool.identity.nativeEventId).toBe('prt_tool')
  expect(tool).toMatchObject({ timing: { startedAt: '2026-07-19T18:07:01.100Z' } })
  expect(evidence.activities.find((activity) => activity.kind === 'assistant')).toMatchObject({
    timing: { completedAt: '2026-07-19T18:07:02.000Z' }
  })
  expect(parsed.totalTokenUsage).toEqual({
    inputTokens: 80,
    outputTokens: 13,
    cacheReadInputTokens: 20,
    cacheCreationInputTokens: 2
  })
  expect(parsed.progressTimestamps).toEqual([
    new Date(timestamp + 1100).toISOString(),
    new Date(timestamp + 2000).toISOString()
  ])
})

it('pins message and part identity encodings', async () => {
  const parsed = await parse('golden')
  expect(parsed.opencodeActivityEvidence).toMatchInlineSnapshot(`
    {
      "activities": [
        {
          "identity": {
            "basis": "native",
            "conversationId": "ses_a",
            "eventId": "opencode:v1:native:1ab6bac669cde4878d6bc81d45e5f92412fde7aed0f1365de69e70607f5cafb2",
            "kind": "part",
            "nativeEventId": "prt_text",
            "parentEventId": "opencode:v1:native:9d366a1ee847602a31b90b150f3cf62592be642a7bd1917e580428bd6d11bf06",
            "provider": "opencode",
            "version": 1,
          },
          "kind": "text",
        },
        {
          "identity": {
            "basis": "native",
            "conversationId": "ses_a",
            "eventId": "opencode:v1:native:2a90970fea63355e20d1bce20b313df8c8631716a56fc8fb4961aa51733c482a",
            "kind": "part",
            "nativeEventId": "prt_tool",
            "parentEventId": "opencode:v1:native:f741051ccaa14055cceeebf3b162fd32244efd8351e1ce52045b4b3255f6524c",
            "provider": "opencode",
            "version": 1,
          },
          "kind": "tool",
          "timing": {
            "startedAt": "2026-07-19T18:07:01.100Z",
          },
        },
        {
          "identity": {
            "basis": "native",
            "conversationId": "ses_a",
            "eventId": "opencode:v1:native:9d366a1ee847602a31b90b150f3cf62592be642a7bd1917e580428bd6d11bf06",
            "kind": "message",
            "nativeEventId": "msg_user",
            "provider": "opencode",
            "version": 1,
          },
          "kind": "user",
        },
        {
          "identity": {
            "basis": "native",
            "conversationId": "ses_a",
            "eventId": "opencode:v1:native:f741051ccaa14055cceeebf3b162fd32244efd8351e1ce52045b4b3255f6524c",
            "kind": "message",
            "nativeEventId": "msg_reply",
            "parentEventId": "opencode:v1:native:9d366a1ee847602a31b90b150f3cf62592be642a7bd1917e580428bd6d11bf06",
            "provider": "opencode",
            "version": 1,
          },
          "kind": "assistant",
          "timing": {
            "completedAt": "2026-07-19T18:07:02.000Z",
          },
        },
      ],
      "parentConversationId": null,
      "reason": null,
      "status": "captured",
      "version": 1,
    }
  `)
})

it('keeps copied identities through reordered files, moved roots and metadata changes', async () => {
  const first = await parse('original')
  const second = await parse('copy', [assistant, user], [toolPart, textPart], {
    directory: 'D:/moved',
    projectID: 'another-project',
    title: 'Renamed'
  })
  expect(second.opencodeActivityEvidence).toEqual(first.opencodeActivityEvidence)
  expect(second.messages.map((message) => message.activityIdentity)).toEqual(
    first.messages.map((message) => message.activityIdentity)
  )
})

it('keeps identities through corrected measurements and completed or compacted tool content', async () => {
  const first = await parse('before')
  const second = await parse(
    'after',
    [user, { ...assistant, tokens: { input: 500 }, modelID: 'new' }],
    [
      textPart,
      {
        ...toolPart,
        state: {
          status: 'completed',
          input: { path: 'a.ts' },
          output: '',
          time: { start: timestamp + 1100, end: timestamp + 1200, compacted: timestamp + 3000 }
        }
      }
    ]
  )
  expect(second.opencodeActivityEvidence!.activities.map((activity) => activity.identity)).toEqual(
    first.opencodeActivityEvidence!.activities.map((activity) => activity.identity)
  )
  expect(
    second.opencodeActivityEvidence!.activities.find((activity) => activity.kind === 'tool')
  ).toMatchObject({
    timing: {
      startedAt: '2026-07-19T18:07:01.100Z',
      endedAt: '2026-07-19T18:07:01.200Z'
    }
  })
  expect(JSON.stringify(second.opencodeActivityEvidence)).not.toContain('18:07:03.000Z')
  expect(second.totalTokenUsage.inputTokens).toBe(500)
  expect(second.progressTimestamps).toContain(new Date(timestamp + 1200).toISOString())
})

it.each([undefined, null, 'not-a-time', 0, -1, NaN, Infinity, 9e15])(
  'omits invalid optional timing without losing native identities: %s',
  (invalid) => {
    const capture = new OpencodeIdentityCapture('ses_a', null)
    capture.message({ ...assistant, time: { created: timestamp, completed: invalid } })
    capture.part({ ...toolPart, state: { time: { start: invalid, end: invalid } } }, 'msg_reply')
    const evidence = capture.finish()
    expect(evidence.status).toBe('captured')
    expect(evidence.activities).toHaveLength(2)
    expect(evidence.activities.every((activity) => !('timing' in activity))).toBe(true)
  }
)

it('distinguishes native branch continuations while keeping copied prefixes identical', async () => {
  const first = await parse('first')
  const second = await parse(
    'second',
    [user, { ...assistant, id: 'msg_branch' }],
    [textPart, { ...toolPart, messageID: 'msg_branch' }]
  )
  expect(second.messages[0].activityIdentity).toEqual(first.messages[0].activityIdentity)
  expect(second.messages[1].activityIdentity!.eventId).not.toBe(
    first.messages[1].activityIdentity!.eventId
  )
  expect(second.messages[1].activityIdentity!.parentEventId).toBe(
    first.messages[0].activityIdentity!.eventId
  )
  expect(
    second.opencodeActivityEvidence!.activities.find((a) => a.kind === 'tool')!.identity.eventId
  ).not.toBe(
    first.opencodeActivityEvidence!.activities.find((a) => a.kind === 'tool')!.identity.eventId
  )
})

it('keeps agent conversations separate and preserves their session parent', async () => {
  const first = await parse('main')
  const second = await parse(
    'agent',
    [user, assistant].map((m) => ({ ...m, sessionID: 'ses_agent' })),
    [textPart, toolPart].map((p) => ({ ...p, sessionID: 'ses_agent' })),
    { id: 'ses_agent', parentID: 'ses_a' }
  )
  expect(second.opencodeActivityEvidence!.status).toBe('captured')
  expect(second.opencodeActivityEvidence!.parentConversationId).toBe('ses_a')
  expect(second.messages[0].activityIdentity!.eventId).not.toBe(
    first.messages[0].activityIdentity!.eventId
  )
  expect(second.messages[0].activityIdentity!.parentEventId).toBeUndefined()
})

it('captures user compaction and assistant step parts without counting step tokens twice', async () => {
  const parsed = await parse(
    'steps',
    [user, assistant],
    [
      { ...textPart, type: 'compaction', auto: true },
      { ...toolPart, type: 'step-finish', tokens: { input: 100, output: 10 }, cost: 1 }
    ]
  )
  expect(parsed.opencodeActivityEvidence!.activities.map((a) => a.kind)).toContain('compaction')
  expect(parsed.opencodeActivityEvidence!.activities.map((a) => a.kind)).toContain('step-finish')
  expect(parsed.totalTokenUsage.inputTokens).toBe(80)
})

it.each([
  ['missing message ID', { ...assistant, id: undefined }],
  ['missing message session', { ...assistant, sessionID: undefined }],
  ['mismatched message session', { ...assistant, sessionID: 'ses_other' }],
  ['invalid parent', { ...assistant, parentID: '' }],
  ['missing timestamp', { ...assistant, time: {} }]
])('does not invent metadata-only fallback identities: %s', async (_label, message) => {
  const parsed = await parse('incomplete', [user, message], [textPart])
  expect(parsed.opencodeActivityEvidence).toMatchObject({ status: 'unavailable', activities: [] })
  expect(parsed.messages.every((m) => m.activityIdentity === null)).toBe(true)
})

it.each([
  ['missing part ID', { ...toolPart, id: undefined }],
  ['missing part owner', { ...toolPart, messageID: undefined }],
  ['mismatched part session', { ...toolPart, sessionID: 'ses_other' }]
])('invalidates earlier identities for incomplete parts: %s', async (_label, part) => {
  const parsed = await parse('incomplete', [user, assistant], [textPart, part])
  expect(parsed.opencodeActivityEvidence).toMatchObject({ status: 'unavailable', activities: [] })
  expect(parsed.messages.every((m) => m.activityIdentity === null)).toBe(true)
})

it('never uses a session filename as the identity namespace', async () => {
  const parsed = await parse('no-session', [user, assistant], [textPart, toolPart], {
    id: undefined
  })
  expect(parsed.sessionId).toBe('ses_a')
  expect(parsed.opencodeActivityEvidence!.reason).toBe('missing-session-identity')
})

it('rejects a part whose recorded owner disagrees with its containing directory', async () => {
  const data = await fixture('wrong-owner')
  await writeFile(
    join(data.root, 'part', 'msg_reply', 'prt_file_1.json'),
    JSON.stringify({
      ...toolPart,
      messageID: 'msg_other'
    })
  )
  const parsed = (await parseOpencodeSessionFile(data.path))!
  expect(parsed.opencodeActivityEvidence!.reason).toBe('incomplete-part')
  expect(parsed.messages.every((m) => m.activityIdentity === null)).toBe(true)
})

it('keeps local messages when their part directory cannot be read', async () => {
  const data = await fixture('missing-parts', [user, assistant], [textPart])
  await rmdir(join(data.root, 'part', 'msg_reply')) // Empty, disposable fixture directory.
  const parsed = (await parseOpencodeSessionFile(data.path))!
  expect(parsed.messages).toHaveLength(2)
  expect(parsed.opencodeActivityEvidence!.reason).toBe('unreadable-parts')
  expect(parsed.messages.every((m) => m.activityIdentity === null)).toBe(true)
})

it('namespaces messages and parts separately even when their recorded IDs match', async () => {
  const parsed = await parse(
    'same-id',
    [user, assistant],
    [textPart, { ...toolPart, id: assistant.id }]
  )
  const reply = parsed.messages[1].activityIdentity!
  const tool = parsed.opencodeActivityEvidence!.activities.find(
    (activity) => activity.kind === 'tool'
  )!
  expect(tool.identity.nativeEventId).toBe(reply.nativeEventId)
  expect(tool.identity.eventId).not.toBe(reply.eventId)
})

it.each(['message', 'part'])(
  'leaves malformed %s files unavailable while retaining local messages',
  async (kind) => {
    const data = await fixture('malformed')
    const path =
      kind === 'message'
        ? join(data.messageDir, 'msg_broken.json')
        : join(data.root, 'part', 'msg_reply', 'prt_broken.json')
    await writeFile(path, '{')
    const parsed = (await parseOpencodeSessionFile(data.path))!
    expect(parsed.messages).toHaveLength(2)
    expect(parsed.opencodeActivityEvidence!.status).toBe('unavailable')
    expect(parsed.messages.every((m) => m.activityIdentity === null)).toBe(true)
  }
)

it('does not guess a predecessor for user messages from chronological order', async () => {
  const parsed = await parse(
    'users',
    [user, { ...user, id: 'msg_next', time: { created: timestamp + 5000 } }],
    []
  )
  expect(parsed.opencodeActivityEvidence!.status).toBe('captured')
  expect(parsed.messages.map((message) => message.activityIdentity!.parentEventId)).toEqual([
    undefined,
    undefined
  ])
})
