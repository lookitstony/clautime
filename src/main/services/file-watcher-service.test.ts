// @vitest-environment node
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
vi.mock('electron', () => ({ BrowserWindow: {} }))
vi.mock('electron-log/main.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() }
}))
vi.mock('./settings-service', () => ({ settingsService: {} }))
vi.mock('./session-service', () => ({
  sessionService: { _scanInProgress: false, scanSessions: vi.fn() }
}))
vi.mock('./client-project-service', () => ({
  clientProjectService: {
    autoCreateProject: vi.fn(),
    attributeSessions: vi.fn(),
    findProjectByDirectory: vi.fn()
  }
}))
vi.mock('./git-service', () => ({ gitService: {} }))
vi.mock('./discovery-service', () => ({ getClaudeConfigDirs: vi.fn() }))
vi.mock('./provider-tracking', () => ({ isProviderEnabled: () => true }))
vi.mock('../parsers/codex-parser', () => ({
  getCodexSessionsDir: () => 'codex',
  readCodexSessionMeta: vi.fn(async () => ({ cwd: 'C:\\repo\\.claude\\worktrees\\feature' }))
}))
const { fileWatcherService } = await import('./file-watcher-service')
const { sessionService } = await import('./session-service')
const { readCodexSessionMeta } = await import('../parsers/codex-parser')

beforeEach(() => {
  vi.useFakeTimers()
  sessionService._scanInProgress = false
  vi.mocked(readCodexSessionMeta).mockResolvedValue({
    sessionId: 'fixture',
    cwd: 'C:\\repo\\.claude\\worktrees\\feature'
  })
  vi.spyOn(fileWatcherService, '_runIncrementalScan').mockResolvedValue()
})
afterEach(() => {
  vi.clearAllTimers()
  fileWatcherService._debounceTimers.clear()
  fileWatcherService._pendingCodexFiles.clear()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

it('updates a Codex worktree under its main project despite continuous file writes', async () => {
  for (let i = 0; i < 20; i++) {
    fileWatcherService._debouncedCodexScan('rollout.jsonl')
    await vi.advanceTimersByTimeAsync(1000)
  }
  expect(fileWatcherService._runIncrementalScan).toHaveBeenCalledExactlyOnceWith(
    'C--repo',
    'C:\\repo'
  )
})

it('retries Codex updates when another scan is running', async () => {
  sessionService._scanInProgress = true
  fileWatcherService._debouncedCodexScan('rollout.jsonl')
  await vi.advanceTimersByTimeAsync(20_000)
  expect(fileWatcherService._runIncrementalScan).not.toHaveBeenCalled()
  sessionService._scanInProgress = false
  await vi.advanceTimersByTimeAsync(20_000)
  expect(fileWatcherService._runIncrementalScan).toHaveBeenCalledOnce()
})

it('coalesces changed Codex files into one scan per project', async () => {
  vi.mocked(readCodexSessionMeta).mockImplementation(async (file) => ({
    sessionId: 'fixture',
    cwd:
      file === 'other.jsonl'
        ? 'C:\\other\\.claude\\worktrees\\feature'
        : 'C:\\repo\\.claude\\worktrees\\feature'
  }))
  for (let i = 0; i < 50; i++) fileWatcherService._debouncedCodexScan(`rollout-${i}.jsonl`)
  fileWatcherService._debouncedCodexScan('other.jsonl')
  await vi.advanceTimersByTimeAsync(20_000)
  expect(fileWatcherService._runIncrementalScan).toHaveBeenCalledTimes(2)
  expect(fileWatcherService._runIncrementalScan).toHaveBeenCalledWith('C--repo', 'C:\\repo')
  expect(fileWatcherService._runIncrementalScan).toHaveBeenCalledWith('C--other', 'C:\\other')
})

it('keeps writes arriving during a scan for the next deadline', async () => {
  vi.mocked(fileWatcherService._runIncrementalScan).mockImplementationOnce(async () => {
    fileWatcherService._debouncedCodexScan('during-scan.jsonl')
  })
  fileWatcherService._debouncedCodexScan('first.jsonl')
  await vi.advanceTimersByTimeAsync(20_000)
  expect(fileWatcherService._runIncrementalScan).toHaveBeenCalledTimes(1)
  await vi.advanceTimersByTimeAsync(20_000)
  expect(fileWatcherService._runIncrementalScan).toHaveBeenCalledTimes(2)
})

it('retains all project requests when another scan starts during metadata reads', async () => {
  vi.mocked(readCodexSessionMeta).mockImplementationOnce(async () => {
    sessionService._scanInProgress = true
    return { sessionId: 'fixture', cwd: 'C:\\repo\\.claude\\worktrees\\feature' }
  })
  fileWatcherService._debouncedCodexScan('first.jsonl')
  fileWatcherService._debouncedCodexScan('second.jsonl')
  await vi.advanceTimersByTimeAsync(20_000)
  expect(fileWatcherService._runIncrementalScan).not.toHaveBeenCalled()
  sessionService._scanInProgress = false
  await vi.advanceTimersByTimeAsync(20_000)
  expect(fileWatcherService._runIncrementalScan).toHaveBeenCalledOnce()
})

it('cancels pending Codex scans on stop', async () => {
  fileWatcherService._debouncedCodexScan('first.jsonl')
  fileWatcherService.stop()
  await vi.advanceTimersByTimeAsync(20_000)
  expect(fileWatcherService._runIncrementalScan).not.toHaveBeenCalled()
  expect(fileWatcherService._pendingCodexFiles.size).toBe(0)
})

it('notifies the renderer of committed work and unresolved files after a partial background scan', async () => {
  vi.mocked(fileWatcherService._runIncrementalScan).mockRestore()
  const errors = [{ sourceFile: 'legacy.jsonl', message: 'Legacy history needs review' }]
  vi.mocked(sessionService.scanSessions).mockResolvedValue({
    newSessions: 1,
    updatedFiles: 1,
    totalFiles: 2,
    durationMs: 1,
    attributedCount: 0,
    errors
  })
  const send = vi.spyOn(fileWatcherService, '_sendToRenderer').mockImplementation(() => {})
  await fileWatcherService._runIncrementalScan('C--repo', 'C:\\repo')
  expect(send).toHaveBeenCalledWith('watcher:sessionsUpdated', { errors })
})
