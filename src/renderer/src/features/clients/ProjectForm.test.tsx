import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ProjectForm } from './ProjectForm'
import type { Project } from '../../../../shared/types/client-project'

const mockProject: Project = {
  id: 1,
  clientId: 1,
  name: 'ClauTime',
  invoiceName: null,
  stageName: null,
  hourlyRate: null,
  directoryPath: 'C:\\apps\\ClauTime',
  isBillable: true,
  isActive: true,
  createdAt: '2026-03-04T00:00:00.000Z',
  updatedAt: '2026-03-04T00:00:00.000Z'
}

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } }
  })
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  }
}

beforeEach(() => {
  vi.stubGlobal('api', {
    clients: {
      getAll: vi.fn().mockResolvedValue({ success: true, data: [] }),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn()
    },
    projects: {
      getAll: vi.fn().mockResolvedValue({ success: true, data: [] }),
      create: vi.fn().mockResolvedValue({ success: true, data: mockProject }),
      update: vi
        .fn()
        .mockResolvedValue({ success: true, data: { ...mockProject, name: 'Updated' } }),
      delete: vi.fn(),
      attributeSessions: vi.fn(),
      getMarkerStatus: vi.fn().mockResolvedValue({ success: true, data: null }),
      setMarkerInGit: vi.fn().mockResolvedValue({ success: true, data: null })
    },
    dialog: {
      openFolder: vi.fn().mockResolvedValue({ success: true, data: 'C:\\selected\\path' })
    }
  })
})

describe('ProjectForm', () => {
  it('edits a project without requiring a folder on this computer', async () => {
    const user = userEvent.setup()
    render(
      <ProjectForm
        open={true}
        onClose={vi.fn()}
        clientId={1}
        project={{ ...mockProject, directoryPath: null }}
      />,
      { wrapper: createWrapper() }
    )
    await user.click(screen.getByRole('button', { name: 'Save Changes' }))
    await waitFor(() => expect(window.api.projects.update).toHaveBeenCalled())
    expect(vi.mocked(window.api.projects.update).mock.calls[0][1]).not.toHaveProperty(
      'directoryPath'
    )
  })

  it('disconnects the local folder without deleting the project', async () => {
    const user = userEvent.setup()
    render(<ProjectForm open={true} onClose={vi.fn()} clientId={1} project={mockProject} />, {
      wrapper: createWrapper()
    })
    await user.clear(screen.getByLabelText('Folder on this computer'))
    await user.click(screen.getByRole('button', { name: 'Save Changes' }))
    await waitFor(() =>
      expect(window.api.projects.update).toHaveBeenCalledWith(
        mockProject.id,
        expect.objectContaining({ directoryPath: null })
      )
    )
    expect(window.api.projects.delete).not.toHaveBeenCalled()
  })

  it('renders create mode with empty fields', () => {
    render(<ProjectForm open={true} onClose={vi.fn()} clientId={1} project={null} />, {
      wrapper: createWrapper()
    })
    expect(screen.getByText('Add Project')).toBeInTheDocument()
    expect(screen.getByPlaceholderText('Project name')).toHaveValue('')
  })

  it('renders edit mode with pre-filled values', () => {
    render(<ProjectForm open={true} onClose={vi.fn()} clientId={1} project={mockProject} />, {
      wrapper: createWrapper()
    })
    expect(screen.getByText('Edit Project')).toBeInTheDocument()
    expect(screen.getByPlaceholderText('Project name')).toHaveValue('ClauTime')
  })

  it('keeps the ID file in Git when the toggle is turned on for a Git folder', async () => {
    vi.mocked(window.api.projects.getMarkerStatus).mockResolvedValue({
      success: true,
      data: { gitRepo: true, markerPresent: true, keepInGit: false }
    })
    const user = userEvent.setup()
    render(<ProjectForm open={true} onClose={vi.fn()} clientId={1} project={mockProject} />, {
      wrapper: createWrapper()
    })
    await user.click(await screen.findByRole('switch', { name: /Keep ID file in Git/ }))
    await user.click(screen.getByRole('button', { name: 'Save Changes' }))
    await waitFor(() =>
      expect(window.api.projects.setMarkerInGit).toHaveBeenCalledWith(mockProject.id, true)
    )
  })

  it('hides the Git toggle for folders that are not Git checkouts', async () => {
    render(<ProjectForm open={true} onClose={vi.fn()} clientId={1} project={mockProject} />, {
      wrapper: createWrapper()
    })
    await waitFor(() => expect(window.api.projects.getMarkerStatus).toHaveBeenCalled())
    expect(screen.queryByRole('switch', { name: /Keep ID file in Git/ })).toBeNull()
  })

  it('Browse button calls dialog.openFolder and populates path', async () => {
    const user = userEvent.setup()
    render(<ProjectForm open={true} onClose={vi.fn()} clientId={1} project={null} />, {
      wrapper: createWrapper()
    })

    await user.click(screen.getByRole('button', { name: 'Browse' }))

    await waitFor(() => {
      expect(window.api.dialog.openFolder).toHaveBeenCalled()
    })

    // Path should be populated
    const pathInput = screen.getByPlaceholderText(/projects/)
    await waitFor(() => {
      expect(pathInput).toHaveValue('C:\\selected\\path')
    })
  })

  it('billable toggle defaults to checked in create mode', () => {
    render(<ProjectForm open={true} onClose={vi.fn()} clientId={1} project={null} />, {
      wrapper: createWrapper()
    })
    const toggles = screen.getAllByRole('switch')
    // First switch is Billable (should be checked by default), second is Exclude (unchecked)
    expect(toggles[0]).toBeChecked()
    expect(toggles[1]).not.toBeChecked()
  })

  it('calls create mutation on submit with correct data', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()

    render(<ProjectForm open={true} onClose={onClose} clientId={1} project={null} />, {
      wrapper: createWrapper()
    })

    await user.type(screen.getByPlaceholderText('Project name'), 'My Project')
    await user.click(screen.getByRole('button', { name: 'Browse' }))

    await waitFor(() => {
      expect(screen.getByPlaceholderText(/projects/)).toHaveValue('C:\\selected\\path')
    })

    await user.click(screen.getByRole('button', { name: 'Create Project' }))

    await waitFor(() => {
      expect(window.api.projects.create).toHaveBeenCalledWith(
        expect.objectContaining({
          clientId: 1,
          name: 'My Project',
          directoryPath: 'C:\\selected\\path',
          isBillable: true
        })
      )
    })
  })
})
