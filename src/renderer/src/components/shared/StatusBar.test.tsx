import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { StatusBar } from './StatusBar'

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
    live: {
      getTodayStats: vi.fn().mockResolvedValue({
        success: true,
        data: {
          humanHours: '2h 30m',
          agentHours: '1h',
          totalSessions: 5,
          totalPrompts: 42,
          totalTokens: 1234567,
          totalCommits: 3
        }
      })
    },
    sessions: {
      getAll: vi.fn().mockResolvedValue({ success: true, data: [] })
    },
    clientProjects: {
      getClients: vi.fn().mockResolvedValue({ success: true, data: [] })
    },
    git: {
      getSessionIdsWithCommits: vi.fn().mockResolvedValue({ success: true, data: [] })
    }
  })
})

describe('StatusBar', () => {
  it('renders today stats', async () => {
    render(<StatusBar />, { wrapper: createWrapper() })
    expect(await screen.findByText(/5 sessions/)).toBeInTheDocument()
    expect(screen.getByText(/42 prompts/)).toBeInTheDocument()
    expect(screen.getByText(/1\.2M tokens/)).toBeInTheDocument()
    expect(screen.getByText(/3 commits/)).toBeInTheDocument()
    expect(screen.getByText(/today/)).toBeInTheDocument()
  })

  it('has status role for accessibility', () => {
    render(<StatusBar />, { wrapper: createWrapper() })
    expect(screen.getByRole('status')).toBeInTheDocument()
  })

  it('toggles between today and all-time when clicked', async () => {
    render(<StatusBar />, { wrapper: createWrapper() })
    const footer = screen.getByRole('status')
    // Wait for today stats to load
    await screen.findByText(/5 sessions/)
    // Click to toggle to all-time
    fireEvent.click(footer)
    expect(screen.getByText(/all time/)).toBeInTheDocument()
    // Click back to today
    fireEvent.click(footer)
    expect(screen.getByText(/today/)).toBeInTheDocument()
  })

  it('formats tokens in compact format', async () => {
    render(<StatusBar />, { wrapper: createWrapper() })
    // 1234567 should show as 1.2M
    expect(await screen.findByText(/1\.2M tokens/)).toBeInTheDocument()
  })
})
