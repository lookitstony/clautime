import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { LocalFoldersSettings } from './LocalFoldersSettings'

let queryClient: QueryClient
const candidates = [
  { projectSyncId: 'a', projectName: 'Desktop project', directoryPath: 'C:/repo' },
  { projectSyncId: 'b', projectName: 'Other computer', directoryPath: 'D:/repo' }
]
beforeEach(() => {
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  vi.stubGlobal('api', {
    projects: {
      getLocalSetup: vi.fn().mockResolvedValue({
        success: true,
        data: { machineName: 'Desktop', complete: false, candidates }
      }),
      completeLocalSetup: vi.fn().mockResolvedValue({
        success: true,
        data: { machineName: 'Desktop', complete: true, candidates: [] }
      })
    }
  })
})
afterEach(() => {
  cleanup()
  queryClient.clear()
  vi.unstubAllGlobals()
})

function show() {
  render(
    <QueryClientProvider client={queryClient}>
      <LocalFoldersSettings />
    </QueryClientProvider>
  )
}

it('makes no selections or writes automatically and sends only the explicitly selected folder', async () => {
  show()
  const boxes = await screen.findAllByRole('checkbox')
  expect(boxes.every((box) => !(box as HTMLInputElement).checked)).toBe(true)
  expect(window.api.projects.completeLocalSetup).not.toHaveBeenCalled()
  fireEvent.click(boxes[0])
  fireEvent.click(screen.getByRole('button', { name: 'Use selected folders on this computer' }))
  await screen.findByText(/Folder setup is complete/)
  expect(window.api.projects.completeLocalSetup).toHaveBeenCalledWith([candidates[0]])
  expect(screen.queryByRole('checkbox')).not.toBeInTheDocument()
})

it('allows setup with no legacy folders and does not claim the suggested paths', async () => {
  show()
  fireEvent.click(
    await screen.findByRole('button', { name: 'Use selected folders on this computer' })
  )
  await screen.findByText(/Folder setup is complete/)
  expect(window.api.projects.completeLocalSetup).toHaveBeenCalledWith([])
})

it('offers a setup notice and removes it when setup completes', async () => {
  const configure = vi.fn()
  render(
    <QueryClientProvider client={queryClient}>
      <LocalFoldersSettings noticeOnly onConfigure={configure} />
      <LocalFoldersSettings />
    </QueryClientProvider>
  )
  fireEvent.click(await screen.findByRole('button', { name: 'Review folders' }))
  expect(configure).toHaveBeenCalledTimes(1)
  expect(window.api.projects.completeLocalSetup).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Use selected folders on this computer' }))
  await waitFor(() => expect(screen.queryByRole('status')).not.toBeInTheDocument())
})

it('shows conflicts without claiming success or clearing the reviewed selection', async () => {
  vi.mocked(window.api.projects.completeLocalSetup).mockResolvedValue({
    success: false,
    error: { code: 'CONFLICT', message: 'Folder already linked to another project' }
  })
  show()
  const boxes = await screen.findAllByRole('checkbox')
  fireEvent.click(boxes[0])
  fireEvent.click(screen.getByRole('button', { name: 'Use selected folders on this computer' }))
  await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('already linked'))
  expect(boxes[0]).toBeChecked()
  expect(screen.queryByText(/Folder setup is complete/)).not.toBeInTheDocument()
})
