// @vitest-environment node
import { beforeEach, expect, it, vi } from 'vitest'
import { AppError } from '../../shared/types/ipc'

const handlers = new Map<string, (...args: unknown[]) => Promise<unknown>>()
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => Promise<unknown>) =>
      handlers.set(channel, handler)
  }
}))
vi.mock('electron-log/main.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
}))
vi.mock('../db', () => ({ getDb: vi.fn() }))
vi.mock('../services/folder-sync-edit-version', () => ({ assertFreshSyncEdit: vi.fn() }))
vi.mock('../services/local-project-setup', () => ({}))
vi.mock('../services/file-watcher-service', () => ({ fileWatcherService: {} }))
const service = vi.hoisted(() => ({
  getFolderSuggestions: vi.fn(),
  linkSuggestedFolder: vi.fn(),
  declineSuggestedFolder: vi.fn()
}))
vi.mock('../services/client-project-service', () => ({ clientProjectService: service }))

const { registerClientProjectHandlers } = await import('./client-project-handlers')
registerClientProjectHandlers()
const invoke = (channel: string, ...args: unknown[]) => handlers.get(channel)!({}, ...args)

beforeEach(() => {
  for (const fn of Object.values(service)) fn.mockReset()
})

it('rejects malformed suggestion answers before reaching the service', async () => {
  for (const args of [
    ['1', 'C:\\repo'],
    [1, 42],
    [undefined, undefined]
  ]) {
    expect(await invoke('project:linkSuggestedFolder', ...args)).toMatchObject({
      success: false,
      error: { code: 'INVALID_ARGUMENTS' }
    })
  }
  expect(await invoke('project:declineSuggestedFolder', 7)).toMatchObject({
    success: false,
    error: { code: 'INVALID_ARGUMENTS' }
  })
  expect(service.linkSuggestedFolder).not.toHaveBeenCalled()
  expect(service.declineSuggestedFolder).not.toHaveBeenCalled()
})

it('passes service error codes through, since the renderer decides whether to ask again by them', async () => {
  service.linkSuggestedFolder.mockImplementation(() => {
    throw new AppError('SUGGESTION_OUTDATED', 'changed')
  })
  service.declineSuggestedFolder.mockImplementation(() => {
    throw new AppError('SUGGESTION_NOT_FOUND', 'gone')
  })
  expect(await invoke('project:linkSuggestedFolder', 1, 'C:\\repo')).toEqual({
    success: false,
    error: { code: 'SUGGESTION_OUTDATED', message: 'changed' }
  })
  expect(await invoke('project:declineSuggestedFolder', 'C:\\repo')).toEqual({
    success: false,
    error: { code: 'SUGGESTION_NOT_FOUND', message: 'gone' }
  })

  service.linkSuggestedFolder.mockImplementation(() => {
    throw new Error('disk full')
  })
  expect(await invoke('project:linkSuggestedFolder', 1, 'C:\\repo')).toMatchObject({
    success: false,
    error: { code: 'PROJECT_LINK_ERROR' }
  })
})

it('answers suggestions and lists the open ones', async () => {
  service.getFolderSuggestions.mockReturnValue([])
  expect(await invoke('project:getFolderSuggestions')).toEqual({ success: true, data: [] })
  expect(await invoke('project:linkSuggestedFolder', 1, 'C:\\repo')).toEqual({
    success: true,
    data: undefined
  })
  expect(service.linkSuggestedFolder).toHaveBeenCalledWith(1, 'C:\\repo')
  expect(await invoke('project:declineSuggestedFolder', 'C:\\repo')).toMatchObject({
    success: true
  })
  expect(service.declineSuggestedFolder).toHaveBeenCalledWith('C:\\repo')
})
