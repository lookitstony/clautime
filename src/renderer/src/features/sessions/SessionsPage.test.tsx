import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { SessionsPage } from './SessionsPage'
import type { Session } from '../../../../shared/types/session'

const mockSessions: Session[] = [
  {
    id: 1,
    projectPath: 'C:\\apps\\ClawdTime',
    startedAt: new Date().toISOString(),
    endedAt: new Date().toISOString(),
    durationMinutes: 45,
    source: 'auto',
    description: null,
    status: 'completed',
    claudeSessionId: 'abc',
    sourceFile: 'test.jsonl',
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
    sourceFile: 'test2.jsonl',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  }
]

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
    sessions: {
      getAll: vi.fn().mockResolvedValue({ success: true, data: [] }),
      scan: vi.fn().mockResolvedValue({
        success: true,
        data: { newSessions: 0, updatedFiles: 0, totalFiles: 0, durationMs: 100 }
      }),
      getById: vi.fn()
    },
    settings: {
      set: vi.fn().mockResolvedValue({ success: true, data: undefined })
    }
  })
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
    vi.stubGlobal('api', {
      sessions: {
        getAll: vi.fn().mockResolvedValue({ success: true, data: mockSessions }),
        scan: vi.fn(),
        getById: vi.fn()
      }
    })

    render(<SessionsPage />, { wrapper: createWrapper() })
    await waitFor(() => {
      expect(screen.getByText('ClawdTime')).toBeInTheDocument()
    })
    expect(screen.getByText('OtherProject')).toBeInTheDocument()
  })

  it('renders stats bar with correct total', async () => {
    vi.stubGlobal('api', {
      sessions: {
        getAll: vi.fn().mockResolvedValue({ success: true, data: mockSessions }),
        scan: vi.fn(),
        getById: vi.fn()
      }
    })

    render(<SessionsPage />, { wrapper: createWrapper() })
    await waitFor(() => {
      expect(screen.getByText('2')).toBeInTheDocument() // total sessions
    })
    expect(screen.getByText("Today's Total")).toBeInTheDocument()
  })

  it('expands project group on click', async () => {
    vi.stubGlobal('api', {
      sessions: {
        getAll: vi.fn().mockResolvedValue({ success: true, data: mockSessions }),
        scan: vi.fn(),
        getById: vi.fn()
      }
    })

    render(<SessionsPage />, { wrapper: createWrapper() })
    await waitFor(() => {
      expect(screen.getByText('ClawdTime')).toBeInTheDocument()
    })
    // Click to expand
    fireEvent.click(screen.getByText('ClawdTime'))
    // Should show session rows (auto badge)
    await waitFor(() => {
      expect(screen.getAllByText('Auto').length).toBeGreaterThan(0)
    })
  })
})
