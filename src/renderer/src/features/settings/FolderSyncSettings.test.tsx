import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { FolderSyncSettings } from './FolderSyncSettings'
import type { FolderSyncState } from '../../../../shared/types/folder-sync'

let cache: QueryClient
const disconnected: FolderSyncState = {
  connected: false,
  enabled: false,
  workspaceId: null,
  name: null,
  folder: null,
  status: 'disabled',
  lastPublishedAt: null,
  lastImportedAt: null,
  pending: 0,
  issues: [],
  joinReviewRequired: false
}
const connected: FolderSyncState = {
  ...disconnected,
  connected: true,
  enabled: true,
  workspaceId: 'history-1',
  name: 'Work',
  folder: 'C:/shared',
  status: 'idle'
}
const success = <T,>(data: T) => ({ success: true as const, data })
beforeEach(() => {
  cache = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  vi.stubGlobal('api', {
    folderSync: {
      status: vi.fn().mockResolvedValue(success(disconnected)),
      discover: vi.fn().mockResolvedValue(success({ workspaces: [], issues: [] })),
      connect: vi.fn().mockResolvedValue(success(connected)),
      syncNow: vi.fn().mockResolvedValue(success(connected)),
      setEnabled: vi
        .fn()
        .mockResolvedValue(success({ ...connected, enabled: false, status: 'disabled' }))
    },
    syncConflicts: { list: vi.fn().mockResolvedValue(success({ items: [] })), resolve: vi.fn() },
    settings: { getAll: vi.fn().mockResolvedValue(success({ presentationMode: 'false' })) },
    machines: { list: vi.fn().mockResolvedValue(success([])), rename: vi.fn() },
    dialog: { openFolder: vi.fn().mockResolvedValue(success('C:/shared')) }
  })
})
afterEach(() => {
  cleanup()
  cache.clear()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})
function show() {
  render(
    <QueryClientProvider client={cache}>
      <FolderSyncSettings />
    </QueryClientProvider>
  )
}
it('waits on an empty folder and creates history only after an explicit start', async () => {
  show()
  expect(screen.queryByRole('radio')).not.toBeInTheDocument()
  fireEvent.click(await screen.findByRole('button', { name: 'Choose shared folder' }))
  const start = await screen.findByRole('button', { name: 'Start new history here' })
  expect(window.api.folderSync.connect).not.toHaveBeenCalled()
  fireEvent.click(start)
  await waitFor(() =>
    expect(window.api.folderSync.connect).toHaveBeenCalledWith({
      mode: 'create',
      folder: 'C:/shared'
    })
  )
  expect(await screen.findByText(/Work: Local folder checked/)).toBeInTheDocument()
})

it('joins newly arrived history instead of creating when Start is clicked', async () => {
  show()
  fireEvent.click(await screen.findByRole('button', { name: 'Choose shared folder' }))
  const start = await screen.findByRole('button', { name: 'Start new history here' })
  vi.mocked(window.api.folderSync.discover).mockResolvedValue(
    success({
      workspaces: [{ workspaceId: 'arrived', name: 'Work', createdAt: 'x' }],
      issues: []
    })
  )
  fireEvent.click(start)
  await waitFor(() =>
    expect(window.api.folderSync.connect).toHaveBeenCalledWith({
      mode: 'join',
      folder: 'C:/shared',
      workspaceId: 'arrived'
    })
  )
  expect(window.api.folderSync.connect).toHaveBeenCalledTimes(1)
})

it('automatically rechecks an empty folder and joins when history arrives', async () => {
  vi.useFakeTimers()
  await act(async () => {
    show()
  })
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1)
  })
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Choose shared folder' }))
  })
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1)
  })
  expect(screen.getByRole('button', { name: 'Start new history here' })).toBeInTheDocument()
  expect(window.api.folderSync.connect).not.toHaveBeenCalled()
  vi.mocked(window.api.folderSync.discover).mockResolvedValue(
    success({
      workspaces: [{ workspaceId: 'arrived', name: 'Work', createdAt: 'x' }],
      issues: []
    })
  )
  await act(async () => {
    await vi.advanceTimersByTimeAsync(3_000)
  })
  expect(window.api.folderSync.connect).toHaveBeenCalledWith({
    mode: 'join',
    folder: 'C:/shared',
    workspaceId: 'arrived'
  })
  await act(async () => {
    await vi.advanceTimersByTimeAsync(6_000)
  })
  expect(window.api.folderSync.connect).toHaveBeenCalledTimes(1)
})

it('recovers automatically when creation races with an arriving history', async () => {
  show()
  fireEvent.click(await screen.findByRole('button', { name: 'Choose shared folder' }))
  const start = await screen.findByRole('button', { name: 'Start new history here' })
  vi.mocked(window.api.folderSync.discover)
    .mockResolvedValueOnce(success({ workspaces: [], issues: [] }))
    .mockResolvedValue(
      success({
        workspaces: [{ workspaceId: 'arrived', name: 'Work', createdAt: 'x' }],
        issues: []
      })
    )
  vi.mocked(window.api.folderSync.connect)
    .mockResolvedValueOnce({
      success: false,
      error: { code: 'SYNC_HISTORY_ARRIVED', message: 'Shared history has arrived.' }
    })
    .mockResolvedValue(success(connected))
  fireEvent.click(start)
  await waitFor(() =>
    expect(window.api.folderSync.connect).toHaveBeenLastCalledWith({
      mode: 'join',
      folder: 'C:/shared',
      workspaceId: 'arrived'
    })
  )
  expect(await screen.findByText(/Work: Local folder checked/)).toBeInTheDocument()
})
it('joins the only existing history immediately after folder selection', async () => {
  vi.mocked(window.api.folderSync.discover).mockResolvedValue(
    success({ workspaces: [{ workspaceId: 'one', name: 'Work', createdAt: 'x' }], issues: [] })
  )
  show()
  fireEvent.click(await screen.findByRole('button', { name: 'Choose shared folder' }))
  await waitFor(() =>
    expect(window.api.folderSync.connect).toHaveBeenCalledWith({
      mode: 'join',
      folder: 'C:/shared',
      workspaceId: 'one'
    })
  )
})
it('does not create a new history when discovery reports a damaged or incomplete share', async () => {
  vi.mocked(window.api.folderSync.discover).mockResolvedValue(
    success({
      workspaces: [],
      issues: [{ source: 'manifest', code: 'SYNC_ERROR', message: 'History is incomplete.' }]
    })
  )
  show()
  fireEvent.click(await screen.findByRole('button', { name: 'Choose shared folder' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('History is incomplete.')
  expect(window.api.folderSync.connect).not.toHaveBeenCalled()
})
it('requires an explicit selection when a folder contains several histories', async () => {
  vi.mocked(window.api.folderSync.discover).mockResolvedValue(
    success({
      workspaces: [
        { workspaceId: 'one', name: 'First', createdAt: 'x' },
        { workspaceId: 'two', name: 'Second', createdAt: 'x' }
      ],
      issues: []
    })
  )
  show()
  fireEvent.click(await screen.findByRole('button', { name: 'Choose shared folder' }))
  const select = await screen.findByRole('combobox', { name: 'Shared history' })
  const join = screen.getByRole('button', { name: 'Connect' })
  expect(join).toBeDisabled()
  fireEvent.change(select, { target: { value: 'two' } })
  fireEvent.click(join)
  await waitFor(() =>
    expect(window.api.folderSync.connect).toHaveBeenCalledWith({
      mode: 'join',
      folder: 'C:/shared',
      workspaceId: 'two'
    })
  )
})
it('pauses transfer without offering to erase history and surfaces incomplete sync', async () => {
  vi.mocked(window.api.folderSync.status).mockResolvedValue(
    success({
      ...connected,
      status: 'incomplete',
      issues: [{ source: 'delivery', code: 'SYNC_BATCH_GAPS', message: 'A batch is missing.' }]
    })
  )
  show()
  expect(await screen.findByText('A batch is missing.')).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'Pause transfers' }))
  await waitFor(() => expect(window.api.folderSync.setEnabled).toHaveBeenCalledWith(false))
  expect(await screen.findByRole('button', { name: 'Resume transfers' })).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Sync now' })).toBeDisabled()
})

it('relocates only the existing workspace and refuses unrelated history', async () => {
  vi.mocked(window.api.folderSync.status).mockResolvedValue(success(connected))
  vi.mocked(window.api.folderSync.discover).mockResolvedValue(
    success({
      workspaces: [{ workspaceId: 'other-history', name: 'Other', createdAt: 'x' }],
      issues: []
    })
  )
  show()
  fireEvent.click(await screen.findByRole('button', { name: 'Change folder location' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('does not contain this shared history')
  expect(window.api.folderSync.connect).not.toHaveBeenCalled()
  vi.mocked(window.api.folderSync.discover).mockResolvedValue(
    success({
      workspaces: [{ workspaceId: connected.workspaceId!, name: 'Work', createdAt: 'x' }],
      issues: []
    })
  )
  fireEvent.click(screen.getByRole('button', { name: 'Change folder location' }))
  await waitFor(() =>
    expect(window.api.folderSync.connect).toHaveBeenCalledWith({
      mode: 'join',
      folder: 'C:/shared',
      workspaceId: connected.workspaceId
    })
  )
})
