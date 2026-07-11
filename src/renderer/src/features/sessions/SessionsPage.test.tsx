import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router'
import { SessionsPage } from './SessionsPage'
import { useFilterStore } from '@/stores/use-filter-store'
import type { Session } from '../../../../shared/types/session'

const mockSessions: Session[] = [
  {
    id: 1,
    projectPath: 'C:\\apps\\ClauTime',
    startedAt: new Date().toISOString(),
    endedAt: new Date().toISOString(),
    durationMinutes: 45,
    source: 'auto',
    description: null,
    status: 'completed',
    claudeSessionId: 'abc',
    promptCount: 5,
    inputTokens: 0,
    outputTokens: 0,
    sourceFile: 'test.jsonl',
    billable: true,
    projectId: null,
    clientId: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  },
  {
    id: 2,
    projectPath: 'C:\\apps\\OtherProject',
    startedAt: new Date().toISOString(),
    endedAt: new Date().toISOString(),
    durationMinutes: 120,
    source: 'auto',
    description: null,
    status: 'completed',
    claudeSessionId: 'def',
    promptCount: 8,
    inputTokens: 0,
    outputTokens: 0,
    sourceFile: 'test2.jsonl',
    billable: true,
    projectId: null,
    clientId: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  }
]

const mockAttributedSessions: Session[] = [
  {
    id: 1,
    projectPath: 'C:\\apps\\ClauTime',
    startedAt: new Date().toISOString(),
    endedAt: new Date().toISOString(),
    durationMinutes: 45,
    source: 'auto',
    description: null,
    status: 'completed',
    claudeSessionId: 'abc',
    promptCount: 5,
    inputTokens: 0,
    outputTokens: 0,
    sourceFile: 'test.jsonl',
    billable: true,
    projectId: 1,
    clientId: 1,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  },
  {
    id: 2,
    projectPath: 'C:\\apps\\OtherProject',
    startedAt: new Date().toISOString(),
    endedAt: new Date().toISOString(),
    durationMinutes: 120,
    source: 'auto',
    description: null,
    status: 'completed',
    claudeSessionId: 'def',
    promptCount: 8,
    inputTokens: 0,
    outputTokens: 0,
    sourceFile: 'test2.jsonl',
    billable: true,
    projectId: null,
    clientId: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  }
]

const mockClients = [
  {
    id: 1,
    name: 'Acme Corp',
    color: 'var(--project-1)',
    billableRate: null,
    email: null,
    stripeCustomerId: null,
    stageName: null,
    isActive: true,
    createdAt: '',
    updatedAt: ''
  }
]
const mockProjects = [
  {
    id: 1,
    clientId: 1,
    name: 'ClauTime',
    invoiceName: null,
    stageName: null,
    hourlyRate: null,
    directoryPath: 'C:\\apps\\ClauTime',
    isBillable: true,
    isActive: true,
    createdAt: '',
    updatedAt: ''
  }
]

function stubApi(
  sessionsData: Session[] = [],
  clientsData = [] as typeof mockClients,
  projectsData = [] as typeof mockProjects
) {
  vi.stubGlobal('api', {
    sessions: {
      getAll: vi.fn().mockResolvedValue({ success: true, data: sessionsData }),
      scan: vi.fn().mockResolvedValue({
        success: true,
        data: {
          newSessions: 0,
          updatedFiles: 0,
          totalFiles: 0,
          durationMs: 100,
          attributedCount: 0
        }
      }),
      getById: vi.fn()
    },
    clients: {
      getAll: vi.fn().mockResolvedValue({ success: true, data: clientsData })
    },
    projects: {
      getAll: vi.fn().mockResolvedValue({ success: true, data: projectsData }),
      attributeSessions: vi.fn().mockResolvedValue({ success: true, data: 0 })
    },
    settings: {
      set: vi.fn().mockResolvedValue({ success: true, data: undefined })
    }
  })
}

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } }
  })
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return (
      <MemoryRouter>
        <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
      </MemoryRouter>
    )
  }
}

beforeEach(() => {
  stubApi()
  useFilterStore.getState().clearFilters()
})

describe('SessionsPage', () => {
  it('shows empty state when no sessions', async () => {
    render(<SessionsPage />, { wrapper: createWrapper() })
    await waitFor(() => {
      expect(screen.getByText('No Sessions Found')).toBeInTheDocument()
    })
    expect(screen.getByText('Scan for Projects')).toBeInTheDocument()
  })

  it('scan button clears setup_complete to trigger wizard', async () => {
    render(<SessionsPage />, { wrapper: createWrapper() })
    await waitFor(() => {
      expect(screen.getByText('Scan for Projects')).toBeInTheDocument()
    })
    fireEvent.click(screen.getByText('Scan for Projects'))
    await waitFor(() => {
      expect(window.api.settings.set).toHaveBeenCalledWith('setup_complete', '')
    })
  })

  it('renders project groups when sessions exist', async () => {
    stubApi(mockSessions)
    render(<SessionsPage />, { wrapper: createWrapper() })
    await waitFor(() => {
      expect(screen.getByText('ClauTime')).toBeInTheDocument()
    })
    expect(screen.getByText('OtherProject')).toBeInTheDocument()
  })

  it('renders stats bar with correct total', async () => {
    stubApi(mockSessions)
    render(<SessionsPage />, { wrapper: createWrapper() })
    await waitFor(() => {
      expect(screen.getByText('2')).toBeInTheDocument() // total sessions
    })
    expect(screen.getByText('Agent Hours')).toBeInTheDocument()
    expect(screen.getByText('Prompts')).toBeInTheDocument()
  })

  it('expands project group and day on click', async () => {
    stubApi(mockSessions)
    render(<SessionsPage />, { wrapper: createWrapper() })
    await waitFor(() => {
      expect(screen.getByText('ClauTime')).toBeInTheDocument()
    })
    // Expand project group — day headers appear (use Expand All to open everything)
    fireEvent.click(screen.getByText('Expand All'))
    await waitFor(() => {
      expect(screen.getAllByText('Auto').length).toBeGreaterThan(0)
    })
  })

  it('shows client name for attributed sessions', async () => {
    stubApi(mockAttributedSessions, mockClients, mockProjects)
    render(<SessionsPage />, { wrapper: createWrapper() })
    await waitFor(() => {
      expect(screen.getByText('Acme Corp')).toBeInTheDocument()
    })
  })

  it('shows unassigned group for unattributed sessions', async () => {
    stubApi(mockAttributedSessions, mockClients, mockProjects)
    render(<SessionsPage />, { wrapper: createWrapper() })
    await waitFor(() => {
      // The unassigned session (id=2) should show its directory name
      expect(screen.getByText('OtherProject')).toBeInTheDocument()
    })
  })

  it('shows "Map this directory" link in unassigned group', async () => {
    stubApi(mockAttributedSessions, mockClients, mockProjects)
    render(<SessionsPage />, { wrapper: createWrapper() })

    await waitFor(() => {
      expect(screen.getByText('OtherProject')).toBeInTheDocument()
    })

    // Expand the unassigned group
    fireEvent.click(screen.getByText('OtherProject'))

    await waitFor(() => {
      expect(screen.getByText('Map this directory to a client in Clients view')).toBeInTheDocument()
    })
  })

  it('shows client count in stats bar when clients exist', async () => {
    stubApi(mockAttributedSessions, mockClients, mockProjects)
    render(<SessionsPage />, { wrapper: createWrapper() })
    await waitFor(() => {
      expect(screen.getByText('Clients')).toBeInTheDocument()
    })
  })

  it('shows detail panel when a session row is clicked', async () => {
    stubApi(mockSessions)
    render(<SessionsPage />, { wrapper: createWrapper() })

    await waitFor(() => {
      expect(screen.getByText('ClauTime')).toBeInTheDocument()
    })

    // Expand everything
    fireEvent.click(screen.getByText('Expand All'))
    await waitFor(() => {
      expect(screen.getAllByText('Auto').length).toBeGreaterThan(0)
    })

    // Click a session row to open detail panel
    const sessionRows = screen.getAllByRole('button', { name: /^Session/ })
    fireEvent.click(sessionRows[0])

    await waitFor(() => {
      expect(screen.getByRole('region', { name: /details for session/i })).toBeInTheDocument()
    })
    expect(screen.getByText('No description')).toBeInTheDocument()
  })

  it('closes detail panel when clicking same session again', async () => {
    stubApi(mockSessions)
    render(<SessionsPage />, { wrapper: createWrapper() })

    await waitFor(() => {
      expect(screen.getByText('ClauTime')).toBeInTheDocument()
    })

    // Expand everything
    fireEvent.click(screen.getByText('Expand All'))
    await waitFor(() => {
      expect(screen.getAllByText('Auto').length).toBeGreaterThan(0)
    })

    const sessionRows = screen.getAllByRole('button', { name: /^Session/ })
    // Open
    fireEvent.click(sessionRows[0])
    await waitFor(() => {
      expect(screen.getByRole('region', { name: /details for session/i })).toBeInTheDocument()
    })
    // Close by clicking same row
    fireEvent.click(sessionRows[0])
    await waitFor(() => {
      expect(screen.queryByRole('region', { name: /details for session/i })).not.toBeInTheDocument()
    })
  })

  it('shows filtered empty state when filters produce no results', async () => {
    // API returns no sessions (simulating a filter that matches nothing)
    stubApi([], mockClients, mockProjects)
    useFilterStore.getState().setDatePreset('today')
    render(<SessionsPage />, { wrapper: createWrapper() })
    await waitFor(() => {
      expect(screen.getByText('No Matching Sessions')).toBeInTheDocument()
    })
    // Filter bar should still be visible
    expect(screen.getByRole('toolbar', { name: 'Session filters' })).toBeInTheDocument()
    // Clear Filters button in the empty state
    expect(screen.getByText('Clear Filters')).toBeInTheDocument()
  })

  it('hides filter bar when truly no sessions and no filters', async () => {
    stubApi([])
    render(<SessionsPage />, { wrapper: createWrapper() })
    await waitFor(() => {
      expect(screen.getByText('No Sessions Found')).toBeInTheDocument()
    })
    expect(screen.queryByRole('toolbar', { name: 'Session filters' })).not.toBeInTheDocument()
  })
})
