// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { appendFile, mkdir, mkdtemp, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const fixture = vi.hoisted(() => ({ root: '' }))
vi.mock('../db', () => ({ getDb: vi.fn() }))
vi.mock('electron', () => ({ Notification: vi.fn(), shell: {} }))
vi.mock('electron-log/main.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }
}))
vi.mock('./widget-service', () => ({ widgetService: {} }))
vi.mock('./client-project-service', () => ({ clientProjectService: {} }))
vi.mock('./settings-service', () => ({ settingsService: { getSetting: () => null } }))
vi.mock('../parsers/codex-parser', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../parsers/codex-parser')>()),
  getCodexSessionsDir: () => fixture.root
}))

import { liveMonitorService } from './live-monitor-service'

beforeEach(async () => {
  fixture.root = await mkdtemp(join(tmpdir(), 'live-activity-'))
  liveMonitorService._lastMtimeChange.clear()
  liveMonitorService._promptTimestampCache.clear()
  liveMonitorService._codexCwdCache.clear()
})
afterEach(async () => {
  await rm(fixture.root, { recursive: true, force: true })
})

it('detects Codex appends with unchanged Windows mtime, then returns to idle', async () => {
  const start = new Date(2026, 8, 13, 12)
  const midnight = new Date(2026, 8, 13).getTime()
  const dir = join(fixture.root, '2026', '09', '13')
  await mkdir(dir, { recursive: true })
  const file = join(dir, 'rollout.jsonl')
  const record = (type: string, payload: object, at = start): string =>
    JSON.stringify({ timestamp: at.toISOString(), type, payload }) + '\n'
  await writeFile(
    file,
    record('session_meta', { id: 'session', cwd: 'C:\\repo' }) +
      record('response_item', {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'Work' }]
      }) +
      record('event_msg', { type: 'task_complete' })
  )
  await utimes(file, start, start)
  const collect = async (seconds: number) => {
    const results = new Map<string, { lastPromptAt: string; isProcessing: boolean }>()
    await liveMonitorService._collectCodexTimestamps(
      (name, value) => results.set(name, value),
      midnight,
      new Date(+start + seconds * 1000)
    )
    return results.get('C--repo')!
  }
  await collect(0)
  expect((await collect(60)).isProcessing).toBe(false)

  const nextPrompt = new Date(+start + 60_000)
  await appendFile(
    file,
    record(
      'response_item',
      {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'Continue' }]
      },
      nextPrompt
    )
  )
  await utimes(file, start, start)
  expect((await stat(file)).mtime.getTime()).toBe(+start)
  expect(await collect(65)).toEqual({
    lastPromptAt: nextPrompt.toISOString(),
    isProcessing: true
  })
  // A quiet reasoning gap stays active based on the observed append time.
  expect((await collect(200)).isProcessing).toBe(true)

  await appendFile(file, record('event_msg', { type: 'task_complete' }))
  await utimes(file, start, start)
  await collect(205)
  expect((await collect(240)).isProcessing).toBe(false)
})
