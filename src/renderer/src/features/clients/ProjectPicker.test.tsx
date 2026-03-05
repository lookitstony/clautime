import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ProjectPicker } from './ProjectPicker'

vi.mock('./use-unassigned-directories', () => ({
  useUnassignedDirectories: vi.fn()
}))

import { useUnassignedDirectories } from './use-unassigned-directories'
const mockUseUnassignedDirectories = vi.mocked(useUnassignedDirectories)

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } }
  })
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal('api', {
    projects: {
      create: vi.fn().mockResolvedValue({ success: true, data: { id: 10 } }),
      getAll: vi.fn().mockResolvedValue({ success: true, data: [] }),
      attributeSessions: vi.fn().mockResolvedValue({ success: true, data: 0 })
    }
  })
})

describe('ProjectPicker', () => {
  it('shows empty message when no unassigned directories', () => {
    mockUseUnassignedDirectories.mockReturnValue([])
    render(<ProjectPicker clientId={1} open={true} onClose={vi.fn()} />, {
      wrapper: createWrapper()
    })
    expect(screen.getByText('No unassigned projects found.')).toBeInTheDocument()
  })

  it('renders discovered directories with session counts', () => {
    mockUseUnassignedDirectories.mockReturnValue([
      { path: 'C:\\apps\\ClawdTime', name: 'ClawdTime', sessionCount: 3 },
      { path: 'C:\\apps\\Other', name: 'Other', sessionCount: 1 }
    ])
    render(<ProjectPicker clientId={1} open={true} onClose={vi.fn()} />, {
      wrapper: createWrapper()
    })
    expect(screen.getByText('Assign Discovered Projects')).toBeInTheDocument()
    expect(screen.getByText('ClawdTime')).toBeInTheDocument()
    expect(screen.getByText('3 sessions')).toBeInTheDocument()
    expect(screen.getByText('Other')).toBeInTheDocument()
    expect(screen.getByText('1 session')).toBeInTheDocument()
  })

  it('assign button is disabled until items are selected', () => {
    mockUseUnassignedDirectories.mockReturnValue([
      { path: 'C:\\apps\\ClawdTime', name: 'ClawdTime', sessionCount: 3 }
    ])
    render(<ProjectPicker clientId={1} open={true} onClose={vi.fn()} />, {
      wrapper: createWrapper()
    })
    expect(screen.getByText('Assign Projects')).toBeDisabled()

    fireEvent.click(screen.getByLabelText('Select ClawdTime'))
    expect(screen.getByText('Assign 1 Project')).toBeEnabled()
  })

  it('updates button text for multiple selections', () => {
    mockUseUnassignedDirectories.mockReturnValue([
      { path: 'C:\\apps\\A', name: 'A', sessionCount: 2 },
      { path: 'C:\\apps\\B', name: 'B', sessionCount: 1 }
    ])
    render(<ProjectPicker clientId={1} open={true} onClose={vi.fn()} />, {
      wrapper: createWrapper()
    })

    fireEvent.click(screen.getByLabelText('Select A'))
    fireEvent.click(screen.getByLabelText('Select B'))
    expect(screen.getByText('Assign 2 Projects')).toBeInTheDocument()
  })

  it('calls createProject with billable=true by default and attributeSessions on assign', async () => {
    const onClose = vi.fn()
    mockUseUnassignedDirectories.mockReturnValue([
      { path: 'C:\\apps\\ClawdTime', name: 'ClawdTime', sessionCount: 3 }
    ])
    render(<ProjectPicker clientId={5} open={true} onClose={onClose} />, {
      wrapper: createWrapper()
    })

    fireEvent.click(screen.getByLabelText('Select ClawdTime'))
    fireEvent.click(screen.getByText('Assign 1 Project'))

    await waitFor(() => {
      expect(window.api.projects.create).toHaveBeenCalledWith({
        clientId: 5,
        name: 'ClawdTime',
        directoryPath: 'C:\\apps\\ClawdTime',
        isBillable: true
      })
      expect(window.api.projects.attributeSessions).toHaveBeenCalled()
      expect(onClose).toHaveBeenCalled()
    })
  })

  it('respects billable toggle set to off', async () => {
    mockUseUnassignedDirectories.mockReturnValue([
      { path: 'C:\\apps\\ClawdTime', name: 'ClawdTime', sessionCount: 1 }
    ])
    render(<ProjectPicker clientId={1} open={true} onClose={vi.fn()} />, {
      wrapper: createWrapper()
    })

    // Toggle billable off
    fireEvent.click(screen.getByLabelText('Billable ClawdTime'))
    // Select the project
    fireEvent.click(screen.getByLabelText('Select ClawdTime'))
    fireEvent.click(screen.getByText('Assign 1 Project'))

    await waitFor(() => {
      expect(window.api.projects.create).toHaveBeenCalledWith(
        expect.objectContaining({ isBillable: false })
      )
    })
  })

  it('can toggle selection off', () => {
    mockUseUnassignedDirectories.mockReturnValue([
      { path: 'C:\\apps\\A', name: 'A', sessionCount: 1 }
    ])
    render(<ProjectPicker clientId={1} open={true} onClose={vi.fn()} />, {
      wrapper: createWrapper()
    })

    const checkbox = screen.getByLabelText('Select A')
    fireEvent.click(checkbox)
    expect(screen.getByText('Assign 1 Project')).toBeEnabled()

    fireEvent.click(checkbox)
    expect(screen.getByText('Assign Projects')).toBeDisabled()
  })

  it('renders nothing when not open', () => {
    mockUseUnassignedDirectories.mockReturnValue([
      { path: 'C:\\apps\\A', name: 'A', sessionCount: 1 }
    ])
    render(<ProjectPicker clientId={1} open={false} onClose={vi.fn()} />, {
      wrapper: createWrapper()
    })
    expect(screen.queryByText('Assign Discovered Projects')).not.toBeInTheDocument()
  })
})
