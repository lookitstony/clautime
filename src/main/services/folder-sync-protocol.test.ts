// @vitest-environment node
import { expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { gunzipSync, gzipSync } from 'node:zlib'
import {
  SYNC_LIMITS,
  SyncError,
  createWorkspaceManifest,
  decodeSyncBatch,
  decodeWorkspaceManifest,
  encodeSyncBatch,
  parseSyncBatch,
  serializeWorkspaceManifest,
  syncBatchChecksum,
  syncBatchFileName
} from './folder-sync-protocol'
import type { SyncBatchInput, SyncChange } from './folder-sync-protocol'

const WORKSPACE = '0b8f2f47-2f0e-4c47-9d64-3f1f0f0a5a01'
const OTHER_WORKSPACE = '5d2c7c1e-8a0a-4b8e-a1b2-7c7f55c0e9d2'
const WRITER = '9a4f6a3c-1a8b-4e5b-8f0d-2b9f7e6c5d4a'
const DEVICE = 'c3d2e1f0-a9b8-4c7d-8e6f-5a4b3c2d1e0f'
const BATCH = '1f2e3d4c-5b6a-4978-8a9b-0c1d2e3f4a5b'
const CHANGE = '7e6d5c4b-3a29-4180-9f8e-7d6c5b4a3928'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

function change(overrides: Partial<SyncChange> = {}): SyncChange {
  return {
    id: CHANGE,
    kind: 'fact',
    entityType: 'activity-observation',
    entityId: 'claude:session-1:event-1',
    dependencies: [],
    payload: { tokens: { input: 12, output: 3 }, model: 'model-a', ratio: 0.5, cached: null },
    ...overrides
  }
}

function input(overrides: Partial<SyncBatchInput> = {}): SyncBatchInput {
  return {
    workspaceId: WORKSPACE,
    batchId: BATCH,
    writerEpochId: WRITER,
    sequence: 1,
    deviceId: DEVICE,
    dependencies: [],
    changes: [change()],
    ...overrides
  }
}

function body(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { protocol: 1, ...input(), ...overrides }
}

/** Signs arbitrary JSON so structural validation, not the checksum, has to reject it. */
function signed(value: Record<string, unknown>): Buffer {
  return gzipSync(JSON.stringify({ ...value, checksum: syncBatchChecksum(value) }))
}

function decode(bytes: Uint8Array) {
  return decodeSyncBatch(bytes, { workspaceId: WORKSPACE })
}

function errorCode(action: () => unknown): string {
  try {
    action()
  } catch (error) {
    return error instanceof SyncError ? error.code : `unexpected ${String(error)}`
  }
  return 'no error'
}

function reverseKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reverseKeys)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .reverse()
        .map(([key, item]) => [key, reverseKeys(item)])
    )
  }
  return value
}

function withPayload(payload: unknown): SyncBatchInput {
  return input({ changes: [change({ payload: payload as never })] })
}

function nested(levels: number): Record<string, unknown> {
  let value: Record<string, unknown> = {}
  for (let level = 0; level < levels; level++) value = { value }
  return value
}

it('round-trips a batch and derives its immutable file name', () => {
  // Sequences 1-6 are absent: a gap is not a decoding dependency.
  const encoded = encodeSyncBatch(input({ sequence: 7 }))
  expect(encoded.fileName).toBe(`7-${BATCH}.json.gz`)
  expect(syncBatchFileName(encoded.batch)).toBe(encoded.fileName)
  expect(encoded.batch).toEqual({
    protocol: 1,
    ...input({ sequence: 7 }),
    checksum: expect.stringMatching(/^[0-9a-f]{64}$/)
  })
  expect(decode(encoded.bytes)).toEqual(encoded.batch)
  expect(
    parseSyncBatch(JSON.parse(gunzipSync(encoded.bytes).toString()), { workspaceId: WORKSPACE })
  ).toEqual(encoded.batch)
})

it('computes the checksum independently of JSON property order and formatting', () => {
  const encoded = encodeSyncBatch(input())
  const reordered = encodeSyncBatch(reverseKeys(input()) as SyncBatchInput)
  expect(reordered.batch.checksum).toBe(encoded.batch.checksum)
  expect(reordered.bytes.equals(encoded.bytes)).toBe(true)
  const pretty = gzipSync(JSON.stringify(reverseKeys(encoded.batch), null, 2))
  expect(decode(pretty)).toEqual(encoded.batch)
})

it('never yields changes from corrupt, tampered or partial files', () => {
  const { bytes } = encodeSyncBatch(input())
  const rejected = ['SYNC_MALFORMED', 'SYNC_INCOMPLETE', 'SYNC_CHECKSUM_MISMATCH', 'SYNC_TOO_LARGE']
  // Gzip header bytes 4-9 (mtime, extra flags, OS) are informational; the rest is checked.
  for (let index = 10; index < bytes.length; index++) {
    const corrupt = Buffer.from(bytes)
    corrupt[index] ^= 0xff
    expect(rejected).toContain(errorCode(() => decode(corrupt)))
  }
  for (let length = 0; length < bytes.length; length++) {
    expect(['SYNC_INCOMPLETE', 'SYNC_MALFORMED']).toContain(
      errorCode(() => decode(bytes.subarray(0, length)))
    )
  }
  expect(errorCode(() => decode(bytes.subarray(0, bytes.length >> 1)))).toBe('SYNC_INCOMPLETE')
  expect(errorCode(() => decode(Buffer.alloc(0)))).toBe('SYNC_INCOMPLETE')
  expect(errorCode(() => decode(Buffer.from(JSON.stringify(body()))))).toBe('SYNC_MALFORMED')

  const tampered = JSON.parse(gunzipSync(bytes).toString())
  tampered.changes[0].payload.tokens.input = 13
  expect(errorCode(() => decode(gzipSync(JSON.stringify(tampered))))).toBe('SYNC_CHECKSUM_MISMATCH')
})

it('reports newer protocol versions as update required, not as damage', () => {
  expect(errorCode(() => decode(signed(body({ protocol: 2, futureField: true }))))).toBe(
    'SYNC_UPDATE_REQUIRED'
  )
  expect(errorCode(() => decode(gzipSync(JSON.stringify({ protocol: 3 }))))).toBe(
    'SYNC_UPDATE_REQUIRED'
  )
  const missing = body()
  delete missing.protocol
  for (const value of [missing, body({ protocol: 0 }), body({ protocol: -1 })]) {
    expect(errorCode(() => decode(signed(value)))).toBe('SYNC_MALFORMED')
  }
  for (const protocol of [1.5, '1', '2', null]) {
    expect(errorCode(() => decode(signed(body({ protocol }))))).toBe('SYNC_MALFORMED')
  }
  for (const text of ['[]', 'null', '"batch"']) {
    expect(errorCode(() => decode(gzipSync(text)))).toBe('SYNC_MALFORMED')
  }
})

it('rejects a batch from another workspace', () => {
  const { bytes } = encodeSyncBatch(input())
  expect(errorCode(() => decodeSyncBatch(bytes, { workspaceId: OTHER_WORKSPACE }))).toBe(
    'SYNC_WRONG_WORKSPACE'
  )
})

it('bounds compressed and inflated sizes', () => {
  expect(errorCode(() => decode(Buffer.alloc(SYNC_LIMITS.maxBatchBytes + 1)))).toBe(
    'SYNC_TOO_LARGE'
  )
  const bomb = gzipSync(Buffer.alloc(SYNC_LIMITS.maxBatchBytes + 1, ' '))
  expect(bomb.length).toBeLessThan(64 * 1024)
  expect(errorCode(() => decode(bomb))).toBe('SYNC_TOO_LARGE')
  const huge = change({ payload: { text: 'x'.repeat(SYNC_LIMITS.maxBatchBytes) } })
  expect(errorCode(() => encodeSyncBatch(input({ changes: [huge] })))).toBe('SYNC_TOO_LARGE')
})

it('rejects duplicate change IDs and self or repeated dependencies', () => {
  const duplicates = [change(), change({ entityId: 'claude:session-1:event-2' })]
  expect(errorCode(() => encodeSyncBatch(input({ changes: duplicates })))).toBe('SYNC_MALFORMED')
  expect(errorCode(() => decode(signed(body({ changes: duplicates }))))).toBe('SYNC_MALFORMED')
  const other = randomUUID()
  for (const invalid of [
    body({ changes: [change({ dependencies: [CHANGE] })] }),
    body({ changes: [change({ dependencies: [other, other] })] }),
    body({ dependencies: [other, other] }),
    body({ dependencies: [CHANGE] })
  ]) {
    expect(errorCode(() => decode(signed(invalid)))).toBe('SYNC_MALFORMED')
  }
  // Dependencies on changes in other, possibly missing, batches are allowed.
  const later = randomUUID()
  const encoded = encodeSyncBatch(
    input({
      dependencies: [other],
      changes: [change({ dependencies: [later] }), change({ id: later, dependencies: [other] })]
    })
  )
  expect(encoded.batch.dependencies).toEqual([other])
})

it('rejects unknown fields, closed-enum violations and invalid identifiers', () => {
  const invalid: Record<string, unknown>[] = [
    { extra: 1 },
    { batchId: BATCH.toUpperCase() },
    { writerEpochId: 'not-a-uuid' },
    { deviceId: '' },
    { sequence: 0 },
    { sequence: -1 },
    { sequence: 1.5 },
    { sequence: Number.MAX_SAFE_INTEGER + 1 },
    { sequence: '1' },
    { dependencies: ['x'] },
    { dependencies: 'none' },
    { changes: [] },
    { changes: {} },
    { changes: [{ ...change(), extra: true }] },
    { changes: [change({ kind: 'delete' as never })] },
    { changes: [change({ entityType: 'session' as never })] },
    { changes: [change({ entityId: '' })] },
    { changes: [change({ entityId: 'x'.repeat(SYNC_LIMITS.maxEntityIdLength + 1) })] },
    { changes: [change({ entityId: 'line\nbreak' })] },
    { changes: [change({ payload: [] as never })] },
    { changes: [change({ payload: null as never })] }
  ]
  for (const overrides of invalid) {
    expect(errorCode(() => decode(signed(body(overrides))))).toBe('SYNC_MALFORMED')
  }
  expect(errorCode(() => decode(gzipSync(JSON.stringify({ ...body(), checksum: 'ABC' }))))).toBe(
    'SYNC_MALFORMED'
  )
  expect(errorCode(() => encodeSyncBatch({ ...input(), extra: 1 } as SyncBatchInput))).toBe(
    'SYNC_MALFORMED'
  )
})

it('rejects unsafe payload values without polluting prototypes', () => {
  const cyclic: Record<string, unknown> = {}
  cyclic.self = cyclic
  const unsafe: unknown[] = [
    NaN,
    Infinity,
    2 ** 53,
    undefined,
    10n,
    () => 1,
    new Date(0),
    new Map(),
    Symbol('value'),
    '\ud800',
    { [Symbol('key')]: 1 },
    cyclic,
    [undefined]
  ]
  for (const value of unsafe) {
    expect(errorCode(() => encodeSyncBatch(withPayload({ value })))).toBe('SYNC_MALFORMED')
  }
  const depth = SYNC_LIMITS.maxPayloadDepth
  expect(errorCode(() => encodeSyncBatch(withPayload(nested(depth - 1))))).toBe('no error')
  expect(errorCode(() => encodeSyncBatch(withPayload(nested(depth))))).toBe('SYNC_MALFORMED')

  for (const key of ['__proto__', 'constructor', 'prototype']) {
    const payload = JSON.parse(`{"safe":{"${key}":{"polluted":true}}}`)
    expect(errorCode(() => decode(signed(body({ changes: [change({ payload })] }))))).toBe(
      'SYNC_MALFORMED'
    )
  }
  expect(({} as Record<string, unknown>).polluted).toBeUndefined()

  const text = JSON.stringify(body({ checksum: '0'.repeat(64) }))
  expect(text).toContain('"payload":{')
  const json = gunzipSync(encodeSyncBatch(input()).bytes)
  expect(errorCode(() => decode(gzipSync(json)))).toBe('no error')
  const variants = [
    // Lone surrogate, unbounded nesting, byte-order mark, invalid UTF-8.
    Buffer.from(text.replace('"payload":{', '"payload":{"text":"\\ud800",')),
    Buffer.from(
      text.replace('"payload":{', `"payload":{"deep":${'['.repeat(1e5)}${']'.repeat(1e5)},`)
    ),
    Buffer.concat([Buffer.from('﻿'), json]),
    Buffer.from([0x7b, 0xff, 0x7d])
  ]
  for (const variant of variants) {
    expect(errorCode(() => decode(gzipSync(variant)))).toBe('SYNC_MALFORMED')
  }
})

it('lets the domain adapter reject changes without applying anything', () => {
  const seen: string[] = []
  const encoded = encodeSyncBatch(input(), { validateChange: (item) => void seen.push(item.id) })
  expect(seen).toEqual([CHANGE])
  const reject = (): void => {
    throw new Error('payload field "apiKey" is not portable')
  }
  const newer = (): void => {
    throw new SyncError('SYNC_UPDATE_REQUIRED', 'Payload schema 2 is not supported')
  }
  const encodeRejected = () => encodeSyncBatch(input(), { validateChange: reject })
  expect(errorCode(encodeRejected)).toBe('SYNC_MALFORMED')
  for (const [validateChange, code] of [
    [reject, 'SYNC_MALFORMED'],
    [newer, 'SYNC_UPDATE_REQUIRED']
  ] as const) {
    expect(
      errorCode(() => decodeSyncBatch(encoded.bytes, { workspaceId: WORKSPACE, validateChange }))
    ).toBe(code)
  }
})

it('creates portable workspace manifests and rejects damaged or newer ones', () => {
  const manifest = createWorkspaceManifest('  Consulting  ', new Date('2026-09-27T08:30:00Z'))
  expect(manifest).toEqual({
    protocol: 1,
    workspaceId: expect.stringMatching(UUID),
    creationId: expect.stringMatching(UUID),
    createdAt: '2026-09-27T08:30:00.000Z',
    name: 'Consulting'
  })
  expect(manifest.creationId).not.toBe(manifest.workspaceId)
  const bytes = Buffer.from(serializeWorkspaceManifest(manifest))
  expect(decodeWorkspaceManifest(bytes, manifest.workspaceId)).toEqual(manifest)

  const manifestCode = (value: unknown, workspaceId = manifest.workspaceId): string =>
    errorCode(() => decodeWorkspaceManifest(Buffer.from(JSON.stringify(value)), workspaceId))
  expect(manifestCode({ ...manifest, protocol: 2, extra: 1 })).toBe('SYNC_UPDATE_REQUIRED')
  for (const invalid of [
    { ...manifest, extra: 1 },
    { ...manifest, protocol: '1' },
    { ...manifest, creationId: 'x' },
    { ...manifest, createdAt: '2026-09-27' },
    { ...manifest, createdAt: '2026-02-30T00:00:00.000Z' },
    { ...manifest, name: ' padded' },
    { ...manifest, name: 'bell\u0007' }
  ]) {
    expect(manifestCode(invalid)).toBe('SYNC_MALFORMED')
  }
  expect(manifestCode(manifest, OTHER_WORKSPACE)).toBe('SYNC_MALFORMED')
  const { workspaceId } = manifest
  expect(errorCode(() => decodeWorkspaceManifest(bytes.subarray(0, 20), workspaceId))).toBe(
    'SYNC_MALFORMED'
  )
  expect(errorCode(() => decodeWorkspaceManifest(Buffer.alloc(0), workspaceId))).toBe(
    'SYNC_INCOMPLETE'
  )
  for (const name of ['', '   ', 'x'.repeat(SYNC_LIMITS.maxWorkspaceNameLength + 1), 'tab\tname']) {
    expect(errorCode(() => createWorkspaceManifest(name, new Date()))).toBe('SYNC_INVALID_NAME')
  }
  expect(errorCode(() => createWorkspaceManifest('Valid', new Date(NaN)))).toBe('SYNC_MALFORMED')
})
