import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { toast } from 'sonner'
import { SettingsPage } from './SettingsPage'
import { useRescanStore } from '@/stores/use-rescan-store'

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

let queryClient: QueryClient

beforeEach(() => {
  vi.clearAllMocks()
  queryClient = new QueryClient({
    defaultOptions: { queries: { enabled: false, retry: false } }
  })
  useRescanStore.setState({ pending: true, changeToken: 1 })
  vi.stubGlobal('api', {
    updater: { getVersion: vi.fn().mockResolvedValue({ success: true, data: 'test' }) },
    sessions: {
      reset: vi.fn().mockResolvedValue({ success: true, data: undefined }),
      scan: vi.fn().mockResolvedValue({ success: true, data: {} })
    }
  })
})

afterEach(() => {
  cleanup()
  queryClient.clear()
  useRescanStore.setState({ pending: false, changeToken: 0 })
  vi.unstubAllGlobals()
})

async function confirmReset(): Promise<void> {
  render(
    <QueryClientProvider client={queryClient}>
      <SettingsPage />
    </QueryClientProvider>
  )
  fireEvent.click(screen.getByRole('button', { name: 'Detection' }))
  fireEvent.click(screen.getByRole('button', { name: 'Factory Reset' }))
  const dialog = screen.getByRole('alertdialog')
  fireEvent.change(within(dialog).getByPlaceholderText('delete all my data'), {
    target: { value: 'delete all my data' }
  })
  fireEvent.click(within(dialog).getByRole('button', { name: 'Factory Reset' }))
  await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument())
}

it('shows a blocked reset error without scanning or clearing pending changes', async () => {
  const message =
    'Reset is unavailable while activity history is retained. Use Rescan to refresh activity.'
  vi.mocked(window.api.sessions.reset).mockResolvedValue({
    success: false,
    error: { code: 'SESSION_RESET_ERROR', message }
  })
  const invalidate = vi.spyOn(queryClient, 'invalidateQueries')

  await confirmReset()

  expect(window.api.sessions.reset).toHaveBeenCalledOnce()
  expect(window.api.sessions.scan).not.toHaveBeenCalled()
  expect(useRescanStore.getState().pending).toBe(true)
  expect(invalidate).not.toHaveBeenCalled()
  expect(toast.error).toHaveBeenCalledWith(message)
  expect(toast.success).not.toHaveBeenCalled()
})

it('shows a failed re-import without reporting reset completion or clearing pending changes', async () => {
  vi.mocked(window.api.sessions.scan).mockResolvedValue({
    success: false,
    error: { code: 'SESSION_SCAN_ERROR', message: 'Cannot read session logs' }
  })

  await confirmReset()

  expect(window.api.sessions.scan).toHaveBeenCalledOnce()
  expect(useRescanStore.getState().pending).toBe(true)
  expect(toast.error).toHaveBeenCalledWith('Cannot read session logs')
  expect(toast.success).not.toHaveBeenCalled()
})

it('re-imports and refreshes the UI after a successful reset', async () => {
  const invalidate = vi.spyOn(queryClient, 'invalidateQueries')

  await confirmReset()

  expect(window.api.sessions.reset).toHaveBeenCalledOnce()
  expect(window.api.sessions.scan).toHaveBeenCalledOnce()
  expect(useRescanStore.getState().pending).toBe(false)
  for (const key of ['sessions', 'live', 'git']) {
    expect(invalidate).toHaveBeenCalledWith({ queryKey: [key] })
  }
  expect(toast.success).toHaveBeenCalledWith('Factory reset complete — sessions re-imported')
  expect(toast.error).not.toHaveBeenCalled()
})
