// @vitest-environment node
import { expect, it } from 'vitest'
import { buildSync } from 'esbuild'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import type { ParsedSessionData } from '../parsers/types'
import { detectSessions, detectSessionsWithPolicy } from './session-detector'
import { readTrackingPolicy, reportingDateKey } from '../../shared/tracking-policy'

const policy = {
  version: 1,
  normalizationVersion: 1,
  detectorVersion: 1,
  idleTimeoutMinutes: 20,
  reportingTimeZone: 'America/New_York'
}
function parsed(timestamps: string[]): ParsedSessionData {
  const usage = {
    inputTokens: 10,
    outputTokens: 5,
    cacheCreationInputTokens: 2,
    cacheReadInputTokens: 3
  }
  return {
    sessionId: 'fixture-conversation',
    sourceFile: 'fixture.jsonl',
    projectPathEncoded: '',
    projectDirectory: '/fixture',
    messages: timestamps.map((timestamp) => ({
      type: 'user',
      timestamp,
      sessionId: 'fixture-conversation',
      cwd: '/fixture',
      gitBranch: null,
      model: 'fixture-model',
      usage,
      uuid: null,
      parentUuid: null,
      isToolResult: false,
      hasToolUse: false,
      toolNames: []
    })),
    firstTimestamp: timestamps[0] ?? null,
    lastTimestamp: timestamps.at(-1) ?? null,
    progressTimestamps: [],
    subagentProgressTimestamps: [],
    subagentMessages: [],
    models: ['fixture-model'],
    totalTokenUsage: {
      inputTokens: 10 * timestamps.length,
      outputTokens: 5 * timestamps.length,
      cacheCreationInputTokens: 2 * timestamps.length,
      cacheReadInputTokens: 3 * timestamps.length
    },
    subagentTokenUsage: {
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0
    },
    messageCount: timestamps.length,
    summary: null
  }
}
const crossings = [
  ['UTC', '2026-08-14T00:00:00.000Z'],
  ['America/New_York', '2026-08-14T04:00:00.000Z'],
  ['Asia/Kathmandu', '2026-08-13T18:15:00.000Z'],
  ['America/Santiago', '2026-09-06T04:00:00.000Z'],
  ['America/Havana', '2026-03-08T05:00:00.000Z'],
  ['Pacific/Apia', '2011-12-30T10:00:00.000Z']
]
function around(boundary: string) {
  return parsed(
    [-4, -2, 2, 10].map((minute) => new Date(Date.parse(boundary) + minute * 60000).toISOString())
  )
}

it.each(crossings)(
  'splits at the reporting day boundary for %s, retaining minutes and model totals',
  (reportingTimeZone, boundary) => {
    const result = detectSessionsWithPolicy([around(boundary)], { ...policy, reportingTimeZone })
    expect(result).toHaveLength(2)
    expect(result.map((row) => row.durationMinutes)).toEqual([4, 10])
    expect(result[0].endedAt).toBe(boundary)
    expect(result[1].startedAt).toBe(boundary)
    expect(result.reduce((sum, row) => sum + row.promptCount, 0)).toBe(4)
    expect(result.reduce((sum, row) => sum + row.inputTokens, 0)).toBe(40)
    expect(result.reduce((sum, row) => sum + row.outputTokens, 0)).toBe(20)
    expect(result.reduce((sum, row) => sum + row.modelUsage[0].cacheReadInputTokens, 0)).toBe(12)
  }
)

it('assigns a message exactly at reporting midnight to the new segment', () => {
  const input = around('2026-08-14T04:00:00.000Z')
  input.messages[2].timestamp = '2026-08-14T04:00:00.000Z'
  const result = detectSessionsWithPolicy([input], policy)
  expect(result.map((row) => row.durationMinutes)).toEqual([4, 10])
  expect(result.map((row) => row.promptCount)).toEqual([2, 2])
})

it('does not treat daylight-saving jumps or repeated hours within one day as idle or midnight', () => {
  for (const boundary of ['2026-03-08T07:00:00Z', '2026-11-01T06:00:00Z']) {
    const result = detectSessionsWithPolicy([around(boundary)], policy)
    expect(result).toHaveLength(1)
    expect(result[0].durationMinutes).toBe(14)
  }
})

it('preserves genuine overnight idle gaps and the existing local entry point', () => {
  const input = parsed([
    '2026-08-14T03:30:00.000Z',
    '2026-08-14T03:35:00.000Z',
    '2026-08-14T04:30:00.000Z',
    '2026-08-14T04:35:00.000Z'
  ])
  expect(detectSessionsWithPolicy([input], policy).map((row) => row.durationMinutes)).toEqual([
    5, 5
  ])
  const hostZone = Intl.DateTimeFormat().resolvedOptions().timeZone
  expect(detectSessionsWithPolicy([input], { ...policy, reportingTimeZone: hostZone })).toEqual(
    detectSessions(input, 20)
  )
})

it('normalizes explicit offsets before progress comparisons without changing captured facts', () => {
  const input = parsed([
    '2026-08-14T12:00:00+05:45',
    '2026-08-14T12:02:00+05:45',
    '2026-08-14T12:42:00+05:45',
    '2026-08-14T12:44:00+05:45'
  ])
  input.messages[1].hasToolUse = true
  input.messages[1].toolNames = ['Bash']
  input.messages[2].isToolResult = true
  input.progressTimestamps = ['2026-08-14T06:50:00Z']
  const original = structuredClone(input)
  const result = detectSessionsWithPolicy([input], policy)
  expect(result).toHaveLength(1)
  expect(result[0].durationMinutes).toBe(44)
  expect(result[0].startedAt).toBe('2026-08-14T06:15:00.000Z')
  expect(result[0].endedAt).toBe('2026-08-14T06:59:00.000Z')
  expect(input).toEqual(original)
})

it('uses the reporting calendar for day keys, including skipped dates and fractional offsets', () => {
  expect(reportingDateKey('2026-08-14T03:59:00Z', policy)).toBe('2026-08-13')
  expect(reportingDateKey('2026-08-14T04:00:00Z', policy)).toBe('2026-08-14')
  expect(
    reportingDateKey('2026-08-13T18:15:00Z', { ...policy, reportingTimeZone: 'Asia/Kathmandu' })
  ).toBe('2026-08-14')
  expect(
    reportingDateKey('2011-12-30T10:00:00Z', { ...policy, reportingTimeZone: 'Pacific/Apia' })
  ).toBe('2011-12-31')
})

it.each([
  null,
  { ...policy, reportingTimeZone: undefined },
  { ...policy, reportingTimeZone: '' },
  { ...policy, reportingTimeZone: 'Invalid/Zone' },
  { ...policy, idleTimeoutMinutes: '20' },
  { ...policy, idleTimeoutMinutes: 0 },
  { ...policy, idleTimeoutMinutes: Infinity },
  { ...policy, version: 2 },
  { ...policy, normalizationVersion: 3 },
  { ...policy, normalizationVersion: 0 },
  { ...policy, normalizationVersion: '2' },
  { ...policy, detectorVersion: 2 },
  { ...policy, unknownFutureRule: true }
])(
  'rejects incompatible or incomplete policies without substituting host defaults (%#)',
  (value) => {
    expect(() => readTrackingPolicy(value)).toThrow()
    expect(() => detectSessionsWithPolicy([], value)).toThrow()
  }
)

it.each([1, 2])('keeps recorded normalization version %s exactly', (normalizationVersion) => {
  const value = { ...policy, normalizationVersion }
  expect(readTrackingPolicy(value)).toEqual(value)
  expect(JSON.stringify(readTrackingPolicy(value))).toBe(JSON.stringify(value))
})

it.each(['2026-08-14T01:00:00', '2026-08-14', 'not-an-instantZ'])(
  'rejects host-dependent or invalid timestamps: %s',
  (timestamp) => {
    expect(() => detectSessionsWithPolicy([parsed([timestamp])], policy)).toThrow('UTC offset')
    expect(() => reportingDateKey(timestamp, policy)).toThrow('UTC offset')
  }
)

it('produces identical sessions and daily totals from independent databases under three host timezones', () => {
  const directory = mkdtempSync(join(tmpdir(), 'clautime-policy-'))
  const target = resolve(directory)
  if (!target.startsWith(resolve(tmpdir()) + sep) || !target.includes('clautime-policy-'))
    throw new Error('Unexpected fixture directory')
  try {
    const runner = join(directory, 'policy.cjs')
    const bundle = buildSync({
      stdin: {
        resolveDir: process.cwd(),
        contents: `
        const Database = require('better-sqlite3');
        const { readFileSync } = require('node:fs');
        const { detectSessionsWithPolicy } = require('./src/main/services/session-detector');
        const { reportingDateKey } = require('./src/shared/tracking-policy');
        const cases = JSON.parse(readFileSync(0, 'utf8'));
        const db = new Database(':memory:');
        db.exec('CREATE TABLE recordings (id INTEGER PRIMARY KEY, payload TEXT NOT NULL)');
        const insert = db.prepare('INSERT INTO recordings(payload) VALUES (?)');
        for (const value of cases) insert.run(JSON.stringify(value));
        const results = db.prepare('SELECT payload FROM recordings ORDER BY id').all().map(({payload}) => {
          const value = JSON.parse(payload);
          const sessions = detectSessionsWithPolicy([value.parsed], value.policy);
          return { sessions, days: sessions.map(row => ({date: reportingDateKey(row.startedAt, value.policy), minutes: row.durationMinutes})) };
        });
        db.close();
        process.stdout.write(JSON.stringify({ offset: new Date('2026-01-01T00:00:00Z').getTimezoneOffset(), results }));
      `
      },
      bundle: true,
      platform: 'node',
      format: 'cjs',
      write: false,
      external: ['better-sqlite3']
    })
    writeFileSync(runner, bundle.outputFiles[0].text)
    const cases = crossings.map(([reportingTimeZone, boundary]) => ({
      parsed: around(boundary),
      policy: { ...policy, reportingTimeZone }
    }))
    const outcomes = ['UTC', 'America/Los_Angeles', 'Asia/Kathmandu'].map((TZ) => {
      const child = spawnSync(process.execPath, [runner], {
        input: JSON.stringify(cases),
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
    expect(outcomes[1].results).toEqual(outcomes[0].results)
    expect(outcomes[2].results).toEqual(outcomes[0].results)
    for (const result of outcomes[0].results)
      expect(result.days.map((day: { minutes: number }) => day.minutes)).toEqual([4, 10])
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})
