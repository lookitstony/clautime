import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ProjectForm } from './ProjectForm'
import type { Project } from '../../../../shared/types/client-project'

const mockProject: Project = {
  id: 1,
  clientId: 1,
  name: 'ClawdTime',
  directoryPath: 'C:\\apps\\ClawdTime',
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
      update: vi.fn().mockResolvedValue({ success: true, data: { ...mockProject, name: 'Updated' } }),
      delete: vi.fn(),
      attributeSessions: vi.fn()
    },
    dialog: {
      openFolder: vi.fn().mockResolvedValue({ success: true, data: 'C:\\selected\\path' })
    }
  })
})

describe('ProjectForm', () => {
  it('renders create mode with empty fields', () => {
    render(
      <ProjectForm open={true} onClose={vi.fn()} clientId={1} project={null} />,
      { wrapper: createWrapper() }
    )
    expect(screen.getByText('Add Project')).toBeInTheDocument()
    expect(screen.getByPlaceholderText('Project name')).toHaveValue('')
  })

  it('renders edit mode with pre-filled values', () => {
    render(
      <ProjectForm open={true} onClose={vi.fn()} clientId={1} project={mockProject} />,
      { wrapper: createWrapper() }
    )
    expect(screen.getByText('Edit Project')).toBeInTheDocument()
    expect(screen.getByPlaceholderText('Project name')).toHaveValue('ClawdTime')
  })

  it('Browse button calls dialog.openFolder and populates path', async () => {
    const user = userEvent.setup()
    render(
      <ProjectForm open={true} onClose={vi.fn()} clientId={1} project={null} />,
      { wrapper: createWrapper() }
    )

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
    render(
      <ProjectForm open={true} onClose={vi.fn()} clientId={1} project={null} />,
      { wrapper: createWrapper() }
    )
    const toggle = screen.getByRole('switch')
    expect(toggle).toBeChecked()
  })

  it('calls create mutation on submit with correct data', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()

    render(
      <ProjectForm open={true} onClose={onClose} clientId={1} project={null} />,
      { wrapper: createWrapper() }
    )

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
