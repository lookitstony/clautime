import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient } from '@tanstack/react-query'
import { Toaster, toast } from 'sonner'
import { showFolderSuggestion, type FolderSuggestion } from './folder-suggestion-toast'

const event: FolderSuggestion = {
  kind: 'suggested',
  projectId: 7,
  projectName: 'Secret Client App',
  directoryPath: 'C:\\work\\clone'
}
const id = `folder-suggestion:${event.directoryPath}`
let qc: QueryClient
/** The options of the newest toast with this id (ids are reused across tests). */
const latestOptions = (): Record<string, unknown> =>
  [...(toast.getHistory() as unknown as Array<Record<string, unknown>>)]
    .reverse()
    .find((entry) => entry.id === id)!
const api = {
  linkSuggestedFolder: vi.fn(),
  declineSuggestedFolder: vi.fn()
}

beforeEach(() => {
  qc = new QueryClient()
  vi.spyOn(qc, 'invalidateQueries')
  api.linkSuggestedFolder.mockReset().mockResolvedValue({ success: true, data: undefined })
  api.declineSuggestedFolder.mockReset().mockResolvedValue({ success: true, data: undefined })
  vi.stubGlobal('api', { projects: api })
  localStorage.clear()
})
afterEach(() => {
  act(() => toast.dismiss())
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('in a real toaster', () => {
  async function show(): Promise<void> {
    render(<Toaster />)
    act(() => showFolderSuggestion(event, qc))
    await screen.findByText('Is this Secret Client App?')
  }

  it('declines with Keep separate even though the prompt cannot be swiped away', async () => {
    await show()
    fireEvent.click(screen.getByRole('button', { name: 'Keep separate' }))
    await waitFor(() => expect(api.declineSuggestedFolder).toHaveBeenCalledWith('C:\\work\\clone'))
    await waitFor(() => expect(screen.queryByText('Is this Secret Client App?')).toBeNull())
    expect(qc.invalidateQueries).toHaveBeenCalledWith({ queryKey: ['projects'] })
    expect(qc.invalidateQueries).toHaveBeenCalledWith({ queryKey: ['sessions'] })
  })

  it('links, and keeps asking when the link can be retried', async () => {
    api.linkSuggestedFolder.mockResolvedValueOnce({
      success: false,
      error: { code: 'PROJECT_LINK_ERROR', message: 'disk busy' }
    })
    await show()
    fireEvent.click(screen.getByRole('button', { name: 'Link' }))
    await screen.findByText('disk busy')
    expect(screen.getByText('Is this Secret Client App?')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Link' }))
    await waitFor(() => expect(api.linkSuggestedFolder).toHaveBeenCalledTimes(2))
    expect(api.linkSuggestedFolder).toHaveBeenLastCalledWith(7, 'C:\\work\\clone')
    await waitFor(() => expect(screen.queryByText('Is this Secret Client App?')).toBeNull())
  })
})

describe('answers', () => {
  it('stops asking once main has closed or outdated the suggestion', async () => {
    const dismiss = vi.spyOn(toast, 'dismiss')
    const error = vi.spyOn(toast, 'error')
    api.linkSuggestedFolder.mockResolvedValue({
      success: false,
      error: { code: 'SUGGESTION_OUTDATED', message: 'changed' }
    })
    showFolderSuggestion(event, qc)
    const options = latestOptions()
    const action = options.action as { onClick: (e: { preventDefault: () => void }) => void }
    action.onClick({ preventDefault: vi.fn() })
    await waitFor(() => expect(error).toHaveBeenCalledWith('changed'))
    expect(dismiss).toHaveBeenCalledWith(id)
  })

  it('keeps asking after the call itself fails', async () => {
    const dismiss = vi.spyOn(toast, 'dismiss')
    vi.spyOn(toast, 'error')
    api.declineSuggestedFolder.mockRejectedValue(new Error('ipc closed'))
    showFolderSuggestion(event, qc)
    const options = latestOptions()
    const cancel = options.cancel as { props: { onClick: () => void } }
    cancel.props.onClick()
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('ipc closed'))
    expect(dismiss).not.toHaveBeenCalledWith(id)
  })
})

it('shows neither the real project name nor the folder in presentation mode', () => {
  qc.setQueryData(['settings', 'all'], { presentation_mode: 'true' })
  qc.setQueryData(
    ['projects', undefined],
    [{ id: 7, name: 'Secret Client App', stageName: 'Demo App' }]
  )
  showFolderSuggestion(event, qc)
  const options = latestOptions()
  expect(options.title).toBe('Is this Demo App?')
  expect(String(options.description)).not.toContain('Secret')
  expect(String(options.description)).not.toContain('clone')
})
